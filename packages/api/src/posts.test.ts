import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { closeDb, db } from "@my-tuums/db";
import { user as userTable } from "@my-tuums/db/schema";
import { appRouter } from "./router.js";
import { POST_MAX_LENGTH } from "./constants.js";
import type { createContext } from "./context.js";

// Integration tests against real Postgres and real BetterAuth sessions, in
// the same spirit as ./router.test.ts — the behaviour worth proving here
// (the (post_id, user_id) primary key making likes idempotent, keyset
// pagination not repeating rows) lives in the database, so mocking it would
// only prove the mock works.

type Context = Awaited<ReturnType<typeof createContext>>;

// Derived from BetterAuth's own return type rather than imported from
// `better-auth` — that package is a dependency of @my-tuums/auth, not of
// this one, so importing it directly resolves at runtime but not for tsc.
type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

interface TestUser {
  id: string;
  session: AuthSession;
}

async function createTestUser(): Promise<TestUser> {
  const { headers, response } = await auth.api.signUpEmail({
    body: {
      email: `vitest+${randomUUID()}@example.com`,
      password: "vitest-password-123",
      name: "Vitest User",
      username: `vitest${randomUUID().slice(0, 8)}`,
    },
    returnHeaders: true,
  });

  const cookie = headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up did not return a session cookie");

  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!session) throw new Error("expected a session immediately after sign-up");

  return { id: response.user.id, session };
}

describe("appRouter.post", () => {
  let author: TestUser;
  let otherUser: TestUser;
  let authorContext: Context;
  let otherContext: Context;
  const anonContext: Context = { db, session: null };

  beforeAll(async () => {
    author = await createTestUser();
    otherUser = await createTestUser();
    authorContext = { db, session: author.session };
    otherContext = { db, session: otherUser.session };
  });

  afterAll(async () => {
    // Posts and likes are ON DELETE CASCADE from user, so removing the two
    // test users cleans up everything this file created.
    await db.delete(userTable).where(inArray(userTable.id, [author.id, otherUser.id]));
    await closeDb();
  });

  describe("create", () => {
    it("rejects an unauthenticated caller", async () => {
      await expect(
        call(appRouter.post.create, { content: "hello" }, { context: anonContext }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("rejects a whitespace-only post", async () => {
      await expect(
        call(appRouter.post.create, { content: "   \n  " }, { context: authorContext }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it(`rejects a post longer than ${String(POST_MAX_LENGTH)} characters`, async () => {
      await expect(
        call(
          appRouter.post.create,
          { content: "x".repeat(POST_MAX_LENGTH + 1) },
          { context: authorContext },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it(`accepts a post of exactly ${String(POST_MAX_LENGTH)} characters`, async () => {
      const result = await call(
        appRouter.post.create,
        { content: "x".repeat(POST_MAX_LENGTH) },
        { context: authorContext },
      );

      expect(result.content).toHaveLength(POST_MAX_LENGTH);
    });

    it("trims surrounding whitespace and returns the post with the author attached", async () => {
      const result = await call(
        appRouter.post.create,
        { content: "  first light  " },
        { context: authorContext },
      );

      expect(result.content).toBe("first light");
      expect(result.author.id).toBe(author.id);
      expect(result.likeCount).toBe(0);
      expect(result.viewerHasLiked).toBe(false);
    });
  });

  describe("list", () => {
    it("returns an author's posts newest first", async () => {
      const older = await call(
        appRouter.post.create,
        { content: "older post" },
        { context: authorContext },
      );
      const newer = await call(
        appRouter.post.create,
        { content: "newer post" },
        { context: authorContext },
      );

      const { items } = await call(
        appRouter.post.list,
        { authorId: author.id, limit: 50 },
        { context: authorContext },
      );

      const ids = items.map((p) => p.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    });

    it("scopes the feed to one author when authorId is given", async () => {
      await call(appRouter.post.create, { content: "by other" }, { context: otherContext });

      const { items } = await call(
        appRouter.post.list,
        { authorId: otherUser.id, limit: 50 },
        { context: authorContext },
      );

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((p) => p.author.id === otherUser.id)).toBe(true);
    });

    it("pages through results without repeating or skipping a row", async () => {
      const pager = await createTestUser();
      const pagerContext: Context = { db, session: pager.session };

      try {
        for (const content of ["p1", "p2", "p3", "p4", "p5"]) {
          await call(appRouter.post.create, { content }, { context: pagerContext });
        }

        // Hoisted so its return type is inferred independently of `cursor`
        // below; inlining the call makes the two types mutually dependent.
        const fetchPage = (cursor?: string) =>
          call(
            appRouter.post.list,
            { authorId: pager.id, limit: 2, ...(cursor ? { cursor } : {}) },
            { context: pagerContext },
          );

        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;

        do {
          const page = await fetchPage(cursor ?? undefined);
          seen.push(...page.items.map((p) => p.content));
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor && pages < 10);

        expect(seen).toEqual(["p5", "p4", "p3", "p2", "p1"]);
        expect(new Set(seen).size).toBe(5);
      } finally {
        await db.delete(userTable).where(eq(userTable.id, pager.id));
      }
    });

    it("rejects a malformed cursor rather than returning the first page", async () => {
      await expect(
        call(appRouter.post.list, { cursor: "not-a-cursor", limit: 10 }, { context: anonContext }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("is readable anonymously, with viewerHasLiked false", async () => {
      const created = await call(
        appRouter.post.create,
        { content: "visible to anyone" },
        { context: authorContext },
      );
      await call(appRouter.post.like, { postId: created.id }, { context: authorContext });

      const { items } = await call(
        appRouter.post.list,
        { authorId: author.id, limit: 50 },
        { context: anonContext },
      );

      const found = items.find((p) => p.id === created.id);
      expect(found?.likeCount).toBe(1);
      expect(found?.viewerHasLiked).toBe(false);
    });
  });

  describe("like / unlike", () => {
    it("rejects an unauthenticated caller", async () => {
      const created = await call(
        appRouter.post.create,
        { content: "auth required to like" },
        { context: authorContext },
      );

      await expect(
        call(appRouter.post.like, { postId: created.id }, { context: anonContext }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("returns NOT_FOUND for a post that does not exist", async () => {
      await expect(
        call(appRouter.post.like, { postId: randomUUID() }, { context: authorContext }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("is idempotent — liking twice still counts once", async () => {
      const created = await call(
        appRouter.post.create,
        { content: "double-clicked" },
        { context: authorContext },
      );

      const first = await call(
        appRouter.post.like,
        { postId: created.id },
        { context: otherContext },
      );
      const second = await call(
        appRouter.post.like,
        { postId: created.id },
        { context: otherContext },
      );

      expect(first.likeCount).toBe(1);
      expect(second.likeCount).toBe(1);
      expect(second.viewerHasLiked).toBe(true);
    });

    it("counts likes from different users separately", async () => {
      const created = await call(
        appRouter.post.create,
        { content: "popular" },
        { context: authorContext },
      );

      await call(appRouter.post.like, { postId: created.id }, { context: authorContext });
      const result = await call(
        appRouter.post.like,
        { postId: created.id },
        { context: otherContext },
      );

      expect(result.likeCount).toBe(2);
    });

    it("unlikes, and unliking again is a no-op", async () => {
      const created = await call(
        appRouter.post.create,
        { content: "changed my mind" },
        { context: authorContext },
      );

      await call(appRouter.post.like, { postId: created.id }, { context: otherContext });
      const first = await call(
        appRouter.post.unlike,
        { postId: created.id },
        { context: otherContext },
      );
      const second = await call(
        appRouter.post.unlike,
        { postId: created.id },
        { context: otherContext },
      );

      expect(first.likeCount).toBe(0);
      expect(first.viewerHasLiked).toBe(false);
      expect(second.likeCount).toBe(0);
    });

    it("reports viewerHasLiked per viewer", async () => {
      const created = await call(
        appRouter.post.create,
        { content: "who liked this" },
        { context: authorContext },
      );
      await call(appRouter.post.like, { postId: created.id }, { context: otherContext });

      const asLiker = await call(
        appRouter.post.list,
        { authorId: author.id, limit: 50 },
        { context: otherContext },
      );
      const asAuthor = await call(
        appRouter.post.list,
        { authorId: author.id, limit: 50 },
        { context: authorContext },
      );

      expect(asLiker.items.find((p) => p.id === created.id)?.viewerHasLiked).toBe(true);
      expect(asAuthor.items.find((p) => p.id === created.id)?.viewerHasLiked).toBe(false);
    });
  });
});
