import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { closeDb, db } from "@my-tuums/db";
import { follow, user as userTable } from "@my-tuums/db/schema";
import { appRouter } from "./router.js";
import { rateLimiter } from "./rate-limit.js";
import type { createContext } from "./context.js";

// Integration tests against real Postgres and real BetterAuth sessions, in the
// same spirit as ./posts.test.ts. Everything worth proving here lives in the
// database — the (follower_id, following_id) primary key making `follow`
// idempotent, the follow_not_self CHECK constraint, and a keyset cursor whose
// tie-breaker is only exercised when two rows share a timestamp — so mocking
// it would only prove the mock works.

type Context = Awaited<ReturnType<typeof createContext>>;

// Derived from BetterAuth's own return type rather than imported from
// `better-auth` — that package is a dependency of @my-tuums/auth, not of
// this one, so importing it directly resolves at runtime but not for tsc.
type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

interface TestUser {
  id: string;
  username: string;
  session: AuthSession;
}

async function createTestUser(): Promise<TestUser> {
  const username = `vitest${randomUUID().slice(0, 8)}`;

  const { headers, response } = await auth.api.signUpEmail({
    body: {
      email: `vitest+${randomUUID()}@example.com`,
      password: "vitest-password-123",
      name: "Vitest User",
      username,
    },
    returnHeaders: true,
  });

  const cookie = headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up did not return a session cookie");

  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!session) throw new Error("expected a session immediately after sign-up");

  return { id: response.user.id, username, session };
}

describe("appRouter.user follow graph", () => {
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let aliceContext: Context;
  let bobContext: Context;
  const anonContext: Context = { db, session: null };

  beforeAll(async () => {
    alice = await createTestUser();
    bob = await createTestUser();
    carol = await createTestUser();
    aliceContext = { db, session: alice.session };
    bobContext = { db, session: bob.session };
  });

  // The limiter is a module-level singleton shared by every procedure, and
  // this file drives far more follow writes through one identity than a human
  // would. Without this the later tests would start failing as
  // TOO_MANY_REQUESTS, which reads like a logic bug.
  beforeEach(() => {
    rateLimiter.clear();
  });

  afterAll(async () => {
    // Follow rows are ON DELETE CASCADE from user on both sides, so removing
    // the test users cleans up everything this file created.
    await db.delete(userTable).where(inArray(userTable.id, [alice.id, bob.id, carol.id]));
    await closeDb();
  });

  describe("follow / unfollow", () => {
    it("is idempotent — following twice still counts once", async () => {
      const first = await call(appRouter.user.follow, { userId: bob.id }, { context: aliceContext });
      const second = await call(
        appRouter.user.follow,
        { userId: bob.id },
        { context: aliceContext },
      );

      expect(first).toMatchObject({ userId: bob.id, followerCount: 1, viewerIsFollowing: true });
      expect(second).toMatchObject({ userId: bob.id, followerCount: 1, viewerIsFollowing: true });

      await call(appRouter.user.unfollow, { userId: bob.id }, { context: aliceContext });
    });

    it("unfollows, and unfollowing again is a no-op", async () => {
      await call(appRouter.user.follow, { userId: bob.id }, { context: aliceContext });

      const first = await call(
        appRouter.user.unfollow,
        { userId: bob.id },
        { context: aliceContext },
      );
      const second = await call(
        appRouter.user.unfollow,
        { userId: bob.id },
        { context: aliceContext },
      );

      expect(first).toMatchObject({ followerCount: 0, viewerIsFollowing: false });
      expect(second).toMatchObject({ followerCount: 0, viewerIsFollowing: false });
    });

    it("rejects following yourself with BAD_REQUEST", async () => {
      await expect(
        call(appRouter.user.follow, { userId: alice.id }, { context: aliceContext }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects a self-follow written straight to the table", async () => {
      // The handler check above is a courtesy; this is the invariant behind
      // it. If the CHECK constraint ever goes missing, the handler alone
      // would let any other write path corrupt every count.
      await expect(
        db.insert(follow).values({ followerId: alice.id, followingId: alice.id }),
      ).rejects.toThrow();
    });

    it("allows unfollowing yourself — the end state is already true", async () => {
      const result = await call(
        appRouter.user.unfollow,
        { userId: alice.id },
        { context: aliceContext },
      );

      expect(result).toMatchObject({ viewerIsFollowing: false });
    });

    it("rejects following someone who doesn't exist with NOT_FOUND", async () => {
      await expect(
        call(appRouter.user.follow, { userId: randomUUID() }, { context: aliceContext }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects an unauthenticated follow with UNAUTHORIZED", async () => {
      await expect(
        call(appRouter.user.follow, { userId: bob.id }, { context: anonContext }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  describe("byUsername", () => {
    beforeEach(async () => {
      await db
        .delete(follow)
        .where(inArray(follow.followerId, [alice.id, bob.id, carol.id]));
    });

    it("reports follower and following counts", async () => {
      await call(appRouter.user.follow, { userId: bob.id }, { context: aliceContext });
      await call(appRouter.user.follow, { userId: bob.id }, { context: bobContext }).catch(
        () => undefined,
      );

      const profile = await call(
        appRouter.user.byUsername,
        { username: bob.username },
        { context: anonContext },
      );

      expect(profile.followerCount).toBe(1);
      expect(profile.followingCount).toBe(0);
    });

    it("reports viewerIsFollowing per viewer, and false when anonymous", async () => {
      await call(appRouter.user.follow, { userId: bob.id }, { context: aliceContext });

      const asFollower = await call(
        appRouter.user.byUsername,
        { username: bob.username },
        { context: aliceContext },
      );
      const asStranger = await call(
        appRouter.user.byUsername,
        { username: bob.username },
        { context: bobContext },
      );
      const asAnon = await call(
        appRouter.user.byUsername,
        { username: bob.username },
        { context: anonContext },
      );

      expect(asFollower.viewerIsFollowing).toBe(true);
      expect(asStranger.viewerIsFollowing).toBe(false);
      expect(asAnon.viewerIsFollowing).toBe(false);
    });

    it("still does not expose the email address", () => {
      // The projection this change edits is the one that keeps `email` out of
      // a public profile, so this guard is re-asserted here rather than
      // trusted to stay true by accident.
      return call(
        appRouter.user.byUsername,
        { username: bob.username },
        { context: anonContext },
      ).then((profile) => {
        expect(profile).not.toHaveProperty("email");
      });
    });
  });

  describe("followers / following", () => {
    beforeEach(async () => {
      await db
        .delete(follow)
        .where(inArray(follow.followerId, [alice.id, bob.id, carol.id]));
    });

    it("points in one direction only", async () => {
      // Alice follows Bob. Bob gains a follower; Alice gains a followee.
      // Getting this backwards is the single most likely bug in the feature.
      await call(appRouter.user.follow, { userId: bob.id }, { context: aliceContext });

      const bobFollowers = await call(
        appRouter.user.followers,
        { username: bob.username },
        { context: anonContext },
      );
      const bobFollowing = await call(
        appRouter.user.following,
        { username: bob.username },
        { context: anonContext },
      );
      const aliceFollowing = await call(
        appRouter.user.following,
        { username: alice.username },
        { context: anonContext },
      );

      expect(bobFollowers.items.map((u) => u.id)).toEqual([alice.id]);
      expect(bobFollowing.items).toEqual([]);
      expect(aliceFollowing.items.map((u) => u.id)).toEqual([bob.id]);
    });

    it("carries viewerIsFollowing on each row", async () => {
      await call(appRouter.user.follow, { userId: bob.id }, { context: aliceContext });
      await call(appRouter.user.follow, { userId: bob.id }, { context: { db, session: carol.session } });

      // Alice looks at Bob's followers: she follows Bob but not Carol, and the
      // rows here are Alice and Carol.
      const asAlice = await call(
        appRouter.user.followers,
        { username: bob.username },
        { context: aliceContext },
      );

      const carolRow = asAlice.items.find((u) => u.id === carol.id);
      expect(carolRow?.viewerIsFollowing).toBe(false);
    });

    it("pages through followers without repeating or skipping a row", async () => {
      // Every row is inserted in one statement, so they all share the same
      // `now()` — which is precisely the case the (created_at, follower_id)
      // tie-breaker exists for. Paginating on created_at alone would repeat
      // or skip rows here.
      const followers = await Promise.all([
        createTestUser(),
        createTestUser(),
        createTestUser(),
        createTestUser(),
        createTestUser(),
      ]);
      const followerIds = followers.map((f) => f.id);

      try {
        await db
          .insert(follow)
          .values(followerIds.map((id) => ({ followerId: id, followingId: carol.id })));

        // Hoisted so its return type is inferred independently of `cursor`
        // below; inlining the call makes the two types mutually dependent.
        const fetchPage = (cursor?: string) =>
          call(
            appRouter.user.followers,
            { username: carol.username, limit: 2, ...(cursor ? { cursor } : {}) },
            { context: anonContext },
          );

        const seen: string[] = [];
        let cursor: string | undefined;

        for (let i = 0; i < 5; i++) {
          const page = await fetchPage(cursor);
          seen.push(...page.items.map((u) => u.id));
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }

        expect(seen).toHaveLength(5);
        expect(new Set(seen).size).toBe(5);
        expect(new Set(seen)).toEqual(new Set(followerIds));
      } finally {
        await db.delete(userTable).where(inArray(userTable.id, followerIds));
      }
    });

    it("rejects an unknown handle with NOT_FOUND rather than an empty page", async () => {
      await expect(
        call(appRouter.user.followers, { username: "nobodyhere" }, { context: anonContext }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects a malformed cursor with BAD_REQUEST", async () => {
      await expect(
        call(
          appRouter.user.followers,
          { username: bob.username, cursor: "not-a-cursor" },
          { context: anonContext },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("pages through followers when every row shares a timestamp", async () => {
      // The tie case again, but asserted on the boundary directly: two rows
      // written in one statement share `now()` to the microsecond, so the
      // second page depends entirely on the follower_id tie-breaker *and* on
      // created_at round-tripping exactly (see the precision: 3 note in
      // packages/db/src/schema/app.ts).
      const [first, second] = await Promise.all([createTestUser(), createTestUser()]);
      const ids = [first.id, second.id];

      try {
        await db
          .insert(follow)
          .values(ids.map((id) => ({ followerId: id, followingId: carol.id })));

        const page1 = await call(
          appRouter.user.followers,
          { username: carol.username, limit: 1 },
          { context: anonContext },
        );
        expect(page1.nextCursor).not.toBeNull();

        const page2 = await call(
          appRouter.user.followers,
          { username: carol.username, limit: 1, cursor: page1.nextCursor ?? "" },
          { context: anonContext },
        );

        expect(page2.items).toHaveLength(1);
        expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
      } finally {
        await db.delete(userTable).where(inArray(userTable.id, ids));
      }
    });
  });

  describe("post.list feed: following", () => {
    beforeEach(async () => {
      await db
        .delete(follow)
        .where(inArray(follow.followerId, [alice.id, bob.id, carol.id]));
    });

    it("rejects an anonymous following feed with UNAUTHORIZED", async () => {
      await expect(
        call(appRouter.post.list, { feed: "following" }, { context: anonContext }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("returns posts by followed authors and the viewer's own, but not strangers'", async () => {
      const bobPost = await call(
        appRouter.post.create,
        { content: `bob says ${randomUUID()}` },
        { context: bobContext },
      );
      const carolPost = await call(
        appRouter.post.create,
        { content: `carol says ${randomUUID()}` },
        { context: { db, session: carol.session } },
      );
      const alicePost = await call(
        appRouter.post.create,
        { content: `alice says ${randomUUID()}` },
        { context: aliceContext },
      );

      await call(appRouter.user.follow, { userId: bob.id }, { context: aliceContext });

      const feed = await call(
        appRouter.post.list,
        { feed: "following", limit: 50 },
        { context: aliceContext },
      );
      const ids = feed.items.map((p) => p.id);

      expect(ids).toContain(bobPost.id);
      // Own posts are included deliberately — the composer sits above this
      // feed, so a post that appeared to vanish on submit would read as a bug.
      expect(ids).toContain(alicePost.id);
      expect(ids).not.toContain(carolPost.id);
    });

    it("still returns everyone's posts on the global feed", async () => {
      const carolPost = await call(
        appRouter.post.create,
        { content: `carol again ${randomUUID()}` },
        { context: { db, session: carol.session } },
      );

      const feed = await call(appRouter.post.list, { limit: 50 }, { context: aliceContext });

      expect(feed.items.map((p) => p.id)).toContain(carolPost.id);
    });

    it("ANDs feed with authorId", async () => {
      const carolPost = await call(
        appRouter.post.create,
        { content: `carol unfollowed ${randomUUID()}` },
        { context: { db, session: carol.session } },
      );

      // Alice doesn't follow Carol, so scoping the following feed to Carol
      // yields nothing rather than Carol's whole timeline.
      const scoped = await call(
        appRouter.post.list,
        { feed: "following", authorId: carol.id, limit: 50 },
        { context: aliceContext },
      );

      expect(scoped.items.map((p) => p.id)).not.toContain(carolPost.id);
    });
  });

  describe("cascade", () => {
    it("removes follow rows when a user is deleted", async () => {
      const doomed = await createTestUser();

      await call(appRouter.user.follow, { userId: doomed.id }, { context: aliceContext });
      await db.delete(userTable).where(eq(userTable.id, doomed.id));

      const orphans = await db
        .select({ followerId: follow.followerId })
        .from(follow)
        .where(and(eq(follow.followerId, alice.id), eq(follow.followingId, doomed.id)));

      expect(orphans).toEqual([]);
    });
  });
});
