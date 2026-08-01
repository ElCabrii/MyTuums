import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { closeDb, db } from "@my-tuums/db";
import { post as postTable, user as userTable } from "@my-tuums/db/schema";
import { appRouter } from "./router.js";
import { POST_MAX_LENGTH, POST_PAGE_SIZE_MAX, THREAD_ANCESTOR_MAX } from "./constants.js";
import { rateLimiter } from "./rate-limit.js";
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

  // Same reason as follows.test.ts: the limiter is a module-level singleton,
  // and this file drives far more writes through one identity than a human
  // would — a thread deep enough to exercise THREAD_ANCESTOR_MAX alone is
  // more posts than the `write` budget allows in a minute. Without this the
  // later tests start failing as TOO_MANY_REQUESTS, which reads like a logic
  // bug in whatever was added last rather than a shared-budget artifact.
  beforeEach(() => {
    rateLimiter.clear();
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
      expect(result.parentId).toBeNull();
    });

    it("records parentId when replying", async () => {
      const parent = await call(
        appRouter.post.create,
        { content: "the original" },
        { context: authorContext },
      );

      const reply = await call(
        appRouter.post.create,
        { content: "the response", parentId: parent.id },
        { context: otherContext },
      );

      expect(reply.parentId).toBe(parent.id);
      expect(reply.replyCount).toBe(0);
    });

    it("returns NOT_FOUND when replying to a post that does not exist", async () => {
      await expect(
        call(
          appRouter.post.create,
          { content: "into the void", parentId: randomUUID() },
          { context: authorContext },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
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

  describe("replies", () => {
    // A dedicated author per test group: the reply assertions are about which
    // rows a feed does and doesn't contain, and the shared `author` above has
    // posts left behind by every other describe in this file.
    let replier: TestUser;
    let replierContext: Context;

    beforeAll(async () => {
      replier = await createTestUser();
      replierContext = { db, session: replier.session };
    });

    afterAll(async () => {
      await db.delete(userTable).where(eq(userTable.id, replier.id));
    });

    it("excludes replies from the global feed", async () => {
      const parent = await call(
        appRouter.post.create,
        { content: "top level, global" },
        { context: replierContext },
      );
      const reply = await call(
        appRouter.post.create,
        { content: "reply, not global", parentId: parent.id },
        { context: replierContext },
      );

      const { items } = await call(
        appRouter.post.list,
        { limit: POST_PAGE_SIZE_MAX },
        { context: replierContext },
      );

      const ids = items.map((p) => p.id);
      expect(ids).toContain(parent.id);
      expect(ids).not.toContain(reply.id);
    });

    it("excludes replies from a profile feed by default, and includes them on request", async () => {
      const parent = await call(
        appRouter.post.create,
        { content: "top level, profile" },
        { context: replierContext },
      );
      const reply = await call(
        appRouter.post.create,
        { content: "reply, profile", parentId: parent.id },
        { context: replierContext },
      );

      const without = await call(
        appRouter.post.list,
        { authorId: replier.id, limit: POST_PAGE_SIZE_MAX },
        { context: replierContext },
      );
      const with_ = await call(
        appRouter.post.list,
        { authorId: replier.id, includeReplies: true, limit: POST_PAGE_SIZE_MAX },
        { context: replierContext },
      );

      expect(without.items.map((p) => p.id)).not.toContain(reply.id);
      expect(with_.items.map((p) => p.id)).toContain(reply.id);
      expect(with_.items.map((p) => p.id)).toContain(parent.id);
    });

    it("lists only the direct replies of one post, newest first", async () => {
      const parent = await call(
        appRouter.post.create,
        { content: "has replies" },
        { context: replierContext },
      );
      const first = await call(
        appRouter.post.create,
        { content: "first reply", parentId: parent.id },
        { context: replierContext },
      );
      const second = await call(
        appRouter.post.create,
        { content: "second reply", parentId: parent.id },
        { context: replierContext },
      );
      // A reply *to a reply* — must not show up under the parent.
      const nested = await call(
        appRouter.post.create,
        { content: "nested reply", parentId: first.id },
        { context: replierContext },
      );

      const { items } = await call(
        appRouter.post.list,
        { parentId: parent.id, limit: POST_PAGE_SIZE_MAX },
        { context: replierContext },
      );

      expect(items.map((p) => p.id)).toEqual([second.id, first.id]);
      expect(items.map((p) => p.id)).not.toContain(nested.id);
    });

    it("pages replies without repeating or skipping a row", async () => {
      const parent = await call(
        appRouter.post.create,
        { content: "heavily discussed" },
        { context: replierContext },
      );

      for (const content of ["r1", "r2", "r3", "r4", "r5"]) {
        await call(appRouter.post.create, { content, parentId: parent.id }, { context: replierContext });
      }

      const fetchPage = (cursor?: string) =>
        call(
          appRouter.post.list,
          { parentId: parent.id, limit: 2, ...(cursor ? { cursor } : {}) },
          { context: replierContext },
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

      expect(seen).toEqual(["r5", "r4", "r3", "r2", "r1"]);
      expect(new Set(seen).size).toBe(5);
    });

    it("counts direct replies only", async () => {
      const parent = await call(
        appRouter.post.create,
        { content: "counting" },
        { context: replierContext },
      );
      const child = await call(
        appRouter.post.create,
        { content: "child", parentId: parent.id },
        { context: replierContext },
      );
      await call(
        appRouter.post.create,
        { content: "grandchild", parentId: child.id },
        { context: replierContext },
      );

      const { post: focused } = await call(
        appRouter.post.thread,
        { postId: parent.id },
        { context: replierContext },
      );

      expect(focused.replyCount).toBe(1);
    });

    it("cascades to replies when the parent is deleted", async () => {
      const parent = await call(
        appRouter.post.create,
        { content: "doomed" },
        { context: replierContext },
      );
      const reply = await call(
        appRouter.post.create,
        { content: "doomed too", parentId: parent.id },
        { context: replierContext },
      );

      await db.delete(postTable).where(eq(postTable.id, parent.id));

      await expect(
        call(appRouter.post.thread, { postId: reply.id }, { context: replierContext }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("thread", () => {
    it("returns NOT_FOUND for a post that does not exist", async () => {
      await expect(
        call(appRouter.post.thread, { postId: randomUUID() }, { context: anonContext }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns no ancestors for a top-level post", async () => {
      const created = await call(
        appRouter.post.create,
        { content: "root of nothing" },
        { context: authorContext },
      );

      const result = await call(
        appRouter.post.thread,
        { postId: created.id },
        { context: authorContext },
      );

      expect(result.post.id).toBe(created.id);
      expect(result.ancestors).toEqual([]);
      expect(result.truncated).toBe(false);
    });

    it("returns the full ancestor chain root-first", async () => {
      const root = await call(appRouter.post.create, { content: "a" }, { context: authorContext });
      const middle = await call(
        appRouter.post.create,
        { content: "b", parentId: root.id },
        { context: otherContext },
      );
      const leaf = await call(
        appRouter.post.create,
        { content: "c", parentId: middle.id },
        { context: authorContext },
      );

      const result = await call(
        appRouter.post.thread,
        { postId: leaf.id },
        { context: authorContext },
      );

      expect(result.post.id).toBe(leaf.id);
      expect(result.ancestors.map((p) => p.id)).toEqual([root.id, middle.id]);
      expect(result.truncated).toBe(false);
    });

    it("carries the same projection on ancestors as a feed does", async () => {
      const root = await call(
        appRouter.post.create,
        { content: "liked ancestor" },
        { context: authorContext },
      );
      await call(appRouter.post.like, { postId: root.id }, { context: otherContext });
      const reply = await call(
        appRouter.post.create,
        { content: "replying to a liked post", parentId: root.id },
        { context: otherContext },
      );

      const result = await call(
        appRouter.post.thread,
        { postId: reply.id },
        { context: otherContext },
      );

      const ancestor = result.ancestors[0];
      expect(ancestor?.likeCount).toBe(1);
      expect(ancestor?.viewerHasLiked).toBe(true);
      expect(ancestor?.replyCount).toBe(1);
      expect(ancestor?.author.id).toBe(author.id);
    });

    it(`caps the chain at ${String(THREAD_ANCESTOR_MAX)} ancestors and reports it as truncated`, async () => {
      const deep = await createTestUser();
      const deepContext: Context = { db, session: deep.session };

      try {
        // Built with direct inserts rather than `post.create`. The chain has
        // to be one deeper than the cap for the cap to be exercised at all,
        // which is more writes than the `write` rate limit allows in a single
        // test — and `create` is not what this test is about. Everything the
        // subject under test reads (parent_id) is set here identically.
        let parentId: string | null = null;
        for (let i = 0; i <= THREAD_ANCESTOR_MAX + 1; i += 1) {
          // Annotated rather than inferred: `parentId` is both an input to
          // this insert and assigned from its result, so letting tsc infer
          // the result type makes the two mutually dependent (TS7022).
          const rows: { id: string }[] = await db
            .insert(postTable)
            .values({ authorId: deep.id, content: `d${String(i)}`, parentId })
            .returning({ id: postTable.id });
          const row = rows[0];
          if (!row) throw new Error("failed to seed the reply chain");
          parentId = row.id;
        }

        const result = await call(
          appRouter.post.thread,
          { postId: parentId ?? "" },
          { context: deepContext },
        );

        expect(result.ancestors).toHaveLength(THREAD_ANCESTOR_MAX);
        expect(result.truncated).toBe(true);
      } finally {
        await db.delete(userTable).where(eq(userTable.id, deep.id));
      }
    });

    it("is readable anonymously, with viewerHasLiked false", async () => {
      const root = await call(appRouter.post.create, { content: "public root" }, { context: authorContext });
      await call(appRouter.post.like, { postId: root.id }, { context: authorContext });
      const reply = await call(
        appRouter.post.create,
        { content: "public reply", parentId: root.id },
        { context: authorContext },
      );

      const result = await call(appRouter.post.thread, { postId: reply.id }, { context: anonContext });

      expect(result.post.viewerHasLiked).toBe(false);
      expect(result.ancestors[0]?.likeCount).toBe(1);
      expect(result.ancestors[0]?.viewerHasLiked).toBe(false);
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
