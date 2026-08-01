import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { inArray } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { closeDb, db } from "@my-tuums/db";
import { user as userTable } from "@my-tuums/db/schema";
import { appRouter } from "./router.js";
import { RATE_LIMITS, rateLimiter } from "./rate-limit.js";
import type { Context } from "./context.js";

// ./rate-limit.test.ts covers the counter itself. What's left to prove is the
// wiring: that the middleware is actually mounted on the procedures that
// write, that it rejects with the right code, and — the part that would be a
// real bug — that one caller exhausting their budget doesn't lock everyone
// else out.

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

async function createTestUser(): Promise<{ id: string; session: AuthSession }> {
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

describe("rateLimit middleware", () => {
  let alice: { id: string; session: AuthSession };
  let bob: { id: string; session: AuthSession };
  let aliceContext: Context;
  let bobContext: Context;

  beforeAll(async () => {
    alice = await createTestUser();
    bob = await createTestUser();
    aliceContext = { db, session: alice.session };
    bobContext = { db, session: bob.session };
  });

  // The limiter is a module-level singleton shared by every procedure, so
  // each test has to start from an empty one or the first burst would spill
  // into the rest.
  beforeEach(() => {
    rateLimiter.clear();
  });

  afterAll(async () => {
    await db.delete(userTable).where(inArray(userTable.id, [alice.id, bob.id]));
    await closeDb();
  });

  it("rejects with TOO_MANY_REQUESTS once the write budget is spent", async () => {
    for (let i = 0; i < RATE_LIMITS.write.limit; i++) {
      await call(appRouter.post.create, { content: `burst ${String(i)}` }, { context: aliceContext });
    }

    await expect(
      call(appRouter.post.create, { content: "one too many" }, { context: aliceContext }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("budgets each user separately", async () => {
    for (let i = 0; i < RATE_LIMITS.write.limit; i++) {
      await call(appRouter.post.create, { content: `burst ${String(i)}` }, { context: aliceContext });
    }

    await expect(
      call(appRouter.post.create, { content: "alice is done" }, { context: aliceContext }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    const bobsPost = await call(
      appRouter.post.create,
      { content: "bob is unaffected" },
      { context: bobContext },
    );

    expect(bobsPost.content).toBe("bob is unaffected");
  });

  it("keeps read and write budgets in separate namespaces", async () => {
    for (let i = 0; i < RATE_LIMITS.write.limit; i++) {
      await call(appRouter.post.create, { content: `burst ${String(i)}` }, { context: aliceContext });
    }

    await expect(
      call(appRouter.post.create, { content: "blocked" }, { context: aliceContext }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    // Spending the write budget must not cost the same caller their reads.
    const feed = await call(
      appRouter.post.list,
      { authorId: alice.id, limit: 10 },
      { context: aliceContext },
    );

    expect(feed.items.length).toBeGreaterThan(0);
  });

  it("budgets anonymous callers by IP", async () => {
    const fromOneIp: Context = { db, session: null, clientIp: "203.0.113.9" };
    const fromAnother: Context = { db, session: null, clientIp: "198.51.100.4" };

    for (let i = 0; i < RATE_LIMITS.read.limit; i++) {
      rateLimiter.consume(`${RATE_LIMITS.read.name}:ip:203.0.113.9`, RATE_LIMITS.read);
    }

    await expect(
      call(appRouter.post.list, { limit: 1 }, { context: fromOneIp }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    await expect(
      call(appRouter.post.list, { limit: 1 }, { context: fromAnother }),
    ).resolves.toBeDefined();
  });

  it("tells the caller how long to wait", async () => {
    for (let i = 0; i < RATE_LIMITS.write.limit; i++) {
      await call(appRouter.post.create, { content: `burst ${String(i)}` }, { context: aliceContext });
    }

    await expect(
      call(appRouter.post.create, { content: "blocked" }, { context: aliceContext }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      data: { retryAfterSeconds: expect.any(Number) as number },
    });
  });
});
