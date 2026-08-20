import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { LEGAL_CONSENT_REQUIRED_MESSAGE, LEGAL_VERSION } from "@my-tuums/auth/rules";
import type { Context } from "./context.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { appRouter } from "./router.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  seedPosts,
  truncateAll,
  type TestUser,
} from "./testing/harness.js";

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
  it("keys signed-in callers on user:<id> — exhausting one user's write budget doesn't touch a second user's", async () => {
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
  }, 20_000);

  it("follow and like are separate namespaces despite costing the same — exhausting the follow budget still leaves liking free, so mass-follow spam can't also lock someone out of liking", async () => {
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
  }, 20_000);

  it("the 429 carries code TOO_MANY_REQUESTS and a positive data.retryAfterSeconds", async () => {
    const actor = await createTestUser();
    const attempts = Array.from({ length: RATE_LIMITS.write.limit }, (_, i) =>
      call(appRouter.post.create, { content: `filler ${i}` }, { context: contextFor(actor) }),
    );
    await Promise.all(attempts);

    let caught: Error | null = null;
    try {
      await call(appRouter.post.create, { content: "over budget" }, { context: contextFor(actor) });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new Error("expected an Error instance", { cause: error });
      }
      caught = error;
    }

    const rateLimitError = z
      .object({
        code: z.literal("TOO_MANY_REQUESTS"),
        data: z.object({ retryAfterSeconds: z.number().positive() }),
      })
      .parse(caught);
    expect(rateLimitError.data.retryAfterSeconds).toBeGreaterThan(0);
  }, 20_000);

  it("auth runs before the rate limiter on protected procedures — anonymous callers never consume budget", async () => {
    // protectedProcedure is base.use(authGuard), and rateLimit() chains
    // after it — so an anonymous call should fail at the auth guard and
    // never reach the limiter at all.
    const attempts = RATE_LIMITS.write.limit + 5;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        call(appRouter.post.create, { content: "nope" }, { context: anonContext }),
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
  }, 20_000);
});

/**
 * The legal consent gate on `protectedProcedure` (issues #157, #158).
 *
 * The create hook in packages/auth refuses a `/sign-up/email` that carries no
 * acceptance, but it cannot cover the paths where no acceptance can be
 * offered at creation — an OAuth or passkey sign-up has no checkbox — nor an
 * account whose acceptance is for a superseded version. Those accounts exist
 * and hold a valid session; this gate is what stops them using the app until
 * the record is there.
 */
describe("legal consent gate", () => {
  /**
   * A caller whose session carries the consent state under test.
   *
   * The gate reads `context.user`, which is the session Better Auth resolved
   * — so overriding it here is exactly what the middleware sees for an OAuth
   * account, one that predates the record, or one holding a stale version.
   */
  function contextWithConsent(
    user: TestUser,
    consent: { legalAcceptedAt: Date | null; legalVersion: string | null },
  ): Context {
    const base = contextFor(user);
    return {
      ...base,
      session: { ...user.session, user: { ...user.session.user, ...consent } },
    };
  }

  it("refuses an account that has never accepted — the OAuth and pre-record shape", async () => {
    const user = await createTestUser();

    await expect(
      call(
        appRouter.post.create,
        { content: "before accepting" },
        { context: contextWithConsent(user, { legalAcceptedAt: null, legalVersion: null }) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: LEGAL_CONSENT_REQUIRED_MESSAGE });
  });

  it("refuses an acceptance of a superseded version", async () => {
    const user = await createTestUser();

    await expect(
      call(
        appRouter.post.create,
        { content: "accepted, but not this version" },
        {
          context: contextWithConsent(user, {
            legalAcceptedAt: new Date("2020-01-01T00:00:00.000Z"),
            legalVersion: "2020-01-01",
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: LEGAL_CONSENT_REQUIRED_MESSAGE });
  });

  it("refuses a timestamp with no version, and a version with no timestamp — neither half is consent on its own", async () => {
    const user = await createTestUser();

    for (const consent of [
      { legalAcceptedAt: new Date(), legalVersion: null },
      { legalAcceptedAt: null, legalVersion: LEGAL_VERSION },
    ]) {
      await expect(
        call(
          appRouter.post.create,
          { content: "half a record" },
          { context: contextWithConsent(user, consent) },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("lets a current acceptance through — the gate is not simply closed", async () => {
    const user = await createTestUser();

    const created = await call(
      appRouter.post.create,
      { content: "after accepting" },
      {
        context: contextWithConsent(user, {
          legalAcceptedAt: new Date(),
          legalVersion: LEGAL_VERSION,
        }),
      },
    );

    expect(created.content).toBe("after accepting");
  });

  /**
   * The escape hatch that has to stay open: a banned account cannot sign in,
   * so its appeal arrives on `baseProcedure` with no session at all. Being
   * asked to accept the terms first would make the appeal unreachable for
   * exactly the people it exists for.
   */
  it("does not reach the signed-out appeal path", async () => {
    await expect(
      call(
        appRouter.moderation.appealOpen,
        { token: "not-a-real-token", reason: "This is my appeal." },
        { context: anonContext },
      ),
    ).rejects.not.toMatchObject({ message: LEGAL_CONSENT_REQUIRED_MESSAGE });
  });
});
