import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { Miniflare } from "miniflare";
import { afterAll, expect, it } from "vitest";
import { createDistributedRateLimiter } from "@my-tuums/api/distributed-rate-limit";
import type { RateLimitPolicy, RateLimitResult } from "@my-tuums/api/rate-limit";

// Execute the production class in workerd; only erase TypeScript, never replace
// its storage or RPC implementation. No account or remote resources are used.
const contents = stripTypeScriptTypes(
  await readFile(new URL("../worker/rate-limit-counter.ts", import.meta.url), "utf8"),
);
function createRuntime(resourcePersistencePath?: string) {
  return new Miniflare({
    resourcePersistencePath,
    workers: [
      {
        config: {
          type: "worker",
          name: "rate-limit-test",
          compatibilityDate: "2026-09-10",
          manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents } } },
          exports: { RateLimitCounter: { type: "durable-object", storage: "sqlite" } },
          env: {
            COUNTERS: {
              type: "durable-object",
              worker: "rate-limit-test",
              exportName: "RateLimitCounter",
            },
          },
        },
      },
    ],
  });
}
type CounterBindings = {
  COUNTERS: {
    getByName(name: string): { consume(policy: RateLimitPolicy): Promise<RateLimitResult> };
  };
};
const runtime = createRuntime();
const { COUNTERS } = await runtime.getBindings<CounterBindings>("rate-limit-test");
afterAll(() => runtime.dispose());

it("shares one budget across concurrent clients and keeps policy/caller budgets separate", async () => {
  const first = createDistributedRateLimiter(COUNTERS);
  const second = createDistributedRateLimiter(COUNTERS);
  const policy = { name: "write", limit: 5, windowMs: 60_000 };
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      (index % 2 ? first : second).consume("user-a", policy),
    ),
  );
  expect(results.filter((result) => result.allowed)).toHaveLength(5);
  expect(
    results
      .filter((result) => !result.allowed)
      .every((result) => result.remaining === 0 && result.retryAfterSeconds > 0),
  ).toBe(true);
  expect(await second.consume("user-b", policy)).toMatchObject({ allowed: true, remaining: 4 });
  expect(await second.consume("user-a", { ...policy, name: "read" })).toMatchObject({
    allowed: true,
    remaining: 4,
  });
});

it("allows a fresh window after expiry and alarm cleanup", async () => {
  const limiter = createDistributedRateLimiter(COUNTERS);
  const policy = { name: "expiry", limit: 1, windowMs: 100 };
  expect(await limiter.consume("expiring-user", policy)).toMatchObject({ allowed: true });
  expect(await limiter.consume("expiring-user", policy)).toMatchObject({ allowed: false });
  await expect
    .poll(async () => (await limiter.consume("expiring-user", policy)).allowed, {
      interval: 150,
      timeout: 5000,
    })
    .toBe(true);
});

it("propagates unavailable storage instead of admitting unmetered requests", async () => {
  const limiter = createDistributedRateLimiter({
    getByName() {
      return { consume: () => Promise.reject(new Error("synthetic outage")) };
    },
  });
  await expect(
    limiter.consume("caller", { name: "read", limit: 3, windowMs: 1000 }),
  ).rejects.toThrow("synthetic outage");
});

it("preserves an exhausted budget across a complete Worker runtime restart", async () => {
  const path = await mkdtemp(join(tmpdir(), "mytuums-rate-limit-test-"));
  let persistentRuntime = createRuntime(path);
  const policy = { name: "restart", limit: 1, windowMs: 60_000 };
  try {
    const first = await persistentRuntime.getBindings<CounterBindings>("rate-limit-test");
    expect(
      await createDistributedRateLimiter(first.COUNTERS).consume("caller", policy),
    ).toMatchObject({ allowed: true });
    await persistentRuntime.dispose();
    persistentRuntime = createRuntime(path);
    const second = await persistentRuntime.getBindings<CounterBindings>("rate-limit-test");
    expect(
      await createDistributedRateLimiter(second.COUNTERS).consume("caller", policy),
    ).toMatchObject({ allowed: false, remaining: 0 });
  } finally {
    await persistentRuntime.dispose();
    await rm(path, { recursive: true, force: true });
  }
}, 15_000);
