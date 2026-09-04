import { call, type AnyProcedure } from "@orpc/server";
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
  it("returns the caller's own user, including email and username — contrast with user.byUsername, which must never expose email (see users.int.test.ts)", async () => {
    const alice = await createTestUser({ name: "Alice Example" });

    const result = await call(appRouter.me, undefined, { context: contextFor(alice) });

    expect(result.id).toBe(alice.id);
    expect(result.name).toBe("Alice Example");
    expect(result.email).toContain("@example.com");
    expect(result.username).toBeTruthy();
  });
});

describe("the session gate", () => {
  it("every procedure on the router refuses an anonymous caller", async () => {
    // The router is exactly two levels — namespaces and their procedures. oRPC
    // marks every leaf procedure with an own `~orpc` key, so walking the object
    // tracks oRPC's own composition rather than a hand-maintained list: a new
    // procedure or namespace is picked up by this sweep without any edit here.
    const leaves: { path: string; procedure: AnyProcedure }[] = [];

    for (const [segment, namespace] of Object.entries(appRouter)) {
      for (const [name, leaf] of Object.entries(namespace)) {
        if (name.startsWith("~")) continue;
        // SAFETY: every second-level entry of the router is an oRPC procedure
        // (oRPC builds the object itself); the marker check turns a wrong
        // assumption into a failing probe below rather than a silent skip.
        if (!("~orpc" in (leaf as object))) continue;
        // SAFETY: the `~orpc` marker just above is oRPC's own procedure mark.
        leaves.push({ path: `${segment}.${name}`, procedure: leaf as AnyProcedure });
      }
    }

    expect(leaves.length).toBeGreaterThan(10);

    // The deliberate exceptions. `appealOpen` is capability-gated, not
    // session-gated (a banned user cannot sign in to appeal), and the
    // public-read leaves serve the two anonymous page families: `post.thread`
    // and the reply modes of `post.list` render the public post permalink
    // (0.4.0), `post.linkCard` renders the cards that thread's posts carry,
    // and `game.bySlug` / `game.list` render the public game directory
    // (issue #314, Q6). Each has its own anonymous-behavior tests; if a new
    // session-less procedure ever appears, this set is where to notice it.
    const sessionless = new Set([
      "moderation.appealOpen",
      "post.thread",
      "post.list",
      "post.linkCard",
      "game.bySlug",
      "game.list",
    ]);

    for (const { path, procedure } of leaves) {
      if (sessionless.has(path)) continue;
      await expect(
        call(procedure, {}, { context: anonContext }),
        `${path} must demand a session`,
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  }, 30_000);
});
