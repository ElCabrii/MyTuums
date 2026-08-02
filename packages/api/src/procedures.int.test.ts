import { call, ORPCError } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RATE_LIMITS } from "./rate-limit.js";
import { appRouter } from "./router.js";
import { anonContext, contextFor, createTestUser, seedPosts, truncateAll } from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

// testing/harness.ts gives every test in this file its own fresh, isolated
// RateLimiter automatically (see the comment on `currentTestRateLimiter`
// there) — that is what lets every scenario below exhaust a budget from a
// clean slate without an explicit reset here. Within one `it()`, every
// `contextFor(...)`/`anonContext` call still shares that same instance
// (the harness only reassigns it BETWEEN tests), so the accumulation these
// tests rely on still works.

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

describe("rate limiting", () => {
  it(
    "keys signed-in callers on user:<id> — exhausting one user's write budget doesn't touch a second user's",
    async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();

      const attempts = Array.from({ length: RATE_LIMITS.write.limit }, (_, i) =>
        call(appRouter.post.create, { content: `alice ${i}` }, { context: contextFor(alice) }),
      );
      await Promise.all(attempts);

      await expect(
        call(appRouter.post.create, { content: "one too many" }, { context: contextFor(alice) }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

      // A different identity is a different bucket — Bob's budget is untouched.
      const bobsPost = await call(
        appRouter.post.create,
        { content: "bob's turn" },
        { context: contextFor(bob) },
      );
      expect(bobsPost.content).toBe("bob's turn");
    },
    20_000,
  );

  it(
    "keys anonymous callers on ip:<clientIp> — exhausting one IP's read budget doesn't touch another IP's",
    async () => {
      const ipA = "203.0.113.9";
      const ipB = "198.51.100.4";

      const attempts = Array.from({ length: RATE_LIMITS.read.limit }, () =>
        call(appRouter.post.list, {}, { context: { ...anonContext, clientIp: ipA } }),
      );
      await Promise.all(attempts);

      await expect(
        call(appRouter.post.list, {}, { context: { ...anonContext, clientIp: ipA } }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

      const stillFine = await call(
        appRouter.post.list,
        {},
        { context: { ...anonContext, clientIp: ipB } },
      );
      expect(stillFine.items).toBeDefined();
    },
    20_000,
  );

  it(
    "callers with no clientIp at all share a single ip:unknown bucket",
    async () => {
      // No clientIp is set on any of these calls, simulating several distinct
      // anonymous callers the transport couldn't resolve an IP for. Treating
      // "no identity" as exempt would make the limit trivially bypassable, so
      // they fall into one shared bucket instead (see procedures.ts).
      const attempts = Array.from({ length: RATE_LIMITS.read.limit }, () =>
        call(appRouter.post.list, {}, { context: { ...anonContext } }),
      );
      await Promise.all(attempts);

      await expect(
        call(appRouter.post.list, {}, { context: { ...anonContext } }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    },
    20_000,
  );

  it(
    "follow and like are separate namespaces despite costing the same — exhausting the follow budget still leaves liking free, so mass-follow spam can't also lock someone out of liking",
    async () => {
      const actor = await createTestUser();
      const target = await createTestUser();
      const author = await createTestUser();
      const [victimPost] = await seedPosts(author.id, 1);

      const attempts = Array.from({ length: RATE_LIMITS.follow.limit }, () =>
        call(appRouter.user.follow, { userId: target.id }, { context: contextFor(actor) }),
      );
      await Promise.all(attempts);

      await expect(
        call(appRouter.user.follow, { userId: target.id }, { context: contextFor(actor) }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

      const likeResult = await call(
        appRouter.post.like,
        { postId: victimPost.id },
        { context: contextFor(actor) },
      );
      expect(likeResult.viewerHasLiked).toBe(true);
    },
    20_000,
  );

  it(
    "the 429 carries code TOO_MANY_REQUESTS and a positive data.retryAfterSeconds",
    async () => {
      const actor = await createTestUser();
      const attempts = Array.from({ length: RATE_LIMITS.write.limit }, (_, i) =>
        call(appRouter.post.create, { content: `filler ${i}` }, { context: contextFor(actor) }),
      );
      await Promise.all(attempts);

      let caught: unknown;
      try {
        await call(
          appRouter.post.create,
          { content: "over budget" },
          { context: contextFor(actor) },
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ORPCError);
      const orpcErr = caught as ORPCError<string, { retryAfterSeconds: number }>;
      expect(orpcErr.code).toBe("TOO_MANY_REQUESTS");
      expect(orpcErr.data.retryAfterSeconds).toBeGreaterThan(0);
    },
    20_000,
  );

  it(
    "auth runs before the rate limiter on protected procedures — anonymous callers never consume budget",
    async () => {
      // protectedProcedure is base.use(authGuard), and rateLimit() chains
      // after it — so an anonymous call should fail at the auth guard and
      // never reach the limiter at all.
      const attempts = RATE_LIMITS.write.limit + 5;
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () =>
          call(
            appRouter.post.create,
            { content: "nope" },
            { context: { ...anonContext, clientIp: "203.0.113.77" } },
          ),
        ),
      );

      expect(results).toHaveLength(attempts);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ code: "UNAUTHORIZED" });
        }
      }

      // If any anonymous attempt above had reached the limiter, this would
      // now read TOO_MANY_REQUESTS instead of succeeding.
      const signedIn = await createTestUser();
      const created = await call(
        appRouter.post.create,
        { content: "hello" },
        { context: contextFor(signedIn) },
      );
      expect(created.content).toBe("hello");
    },
    20_000,
  );
});
