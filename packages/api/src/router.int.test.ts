import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { anonContext, contextFor, createTestUser, truncateAll } from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

// No per-test rate-limit reset needed here — testing/harness.ts registers
// its own beforeEach that gives every test in this file a fresh, isolated
// RateLimiter automatically (see the comment on `currentTestRateLimiter`).

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

describe("appRouter.me", () => {
  it("rejects an anonymous caller", async () => {
    await expect(call(appRouter.me, undefined, { context: anonContext })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("returns the caller's own user, including email and username — contrast with user.byUsername, which must never expose email (see users.int.test.ts)", async () => {
    const alice = await createTestUser({ name: "Alice Example" });

    const result = await call(appRouter.me, undefined, { context: contextFor(alice) });

    expect(result.id).toBe(alice.id);
    expect(result.name).toBe("Alice Example");
    expect(result.email).toContain("@example.com");
    expect(result.username).toBeTruthy();
  });
});
