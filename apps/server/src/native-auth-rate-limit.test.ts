import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { setTimeout } from "node:timers/promises";
import { Miniflare } from "miniflare";
import { afterAll, expect, it } from "vitest";
import { createAuth } from "@my-tuums/auth";
import { createTestDatabase } from "@my-tuums/db/testing/d1";
import {
  createAuthRateLimitStorage,
  type AuthCounterNamespace,
} from "@my-tuums/auth/rate-limit-storage";

const contents = stripTypeScriptTypes(
  await readFile(new URL("../worker/auth-rate-limit-counter.ts", import.meta.url), "utf8"),
);
function createRuntime(resourcePersistencePath?: string) {
  return new Miniflare({
    resourcePersistencePath,
    workers: [
      {
        config: {
          type: "worker",
          name: "auth-counter-test",
          compatibilityDate: "2026-09-10",
          manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents } } },
          exports: { AuthRateLimitCounter: { type: "durable-object", storage: "sqlite" } },
          env: {
            COUNTERS: {
              type: "durable-object",
              worker: "auth-counter-test",
              exportName: "AuthRateLimitCounter",
            },
          },
        },
      },
    ],
  });
}
async function storageFor(runtime: Miniflare) {
  const { COUNTERS } = await runtime.getBindings<{ COUNTERS: AuthCounterNamespace }>(
    "auth-counter-test",
  );
  return createAuthRateLimitStorage(COUNTERS);
}
const runtime = createRuntime();
const storage = await storageFor(runtime);
afterAll(() => runtime.dispose());

it("atomically admits the exact auth budget across concurrent clients", async () => {
  const results = await Promise.all(
    Array.from({ length: 30 }, () =>
      storage.consume("synthetic-ip:reset", { window: 300, max: 3 }),
    ),
  );
  expect(results.filter((result) => result.allowed)).toHaveLength(3);
  expect(
    results.filter((result) => !result.allowed).every((result) => (result.retryAfter ?? 0) > 0),
  ).toBe(true);
  expect(await storage.consume("other-ip:reset", { window: 300, max: 3 })).toMatchObject({
    allowed: true,
  });
});

it("preserves Better Auth's inactivity window and never extends it on denied attempts", async () => {
  const key = "synthetic-ip:rolling";
  const initial = Date.now() - 4500;
  await storage.set(key, { key, count: 1, lastRequest: initial });
  expect(await storage.consume(key, { window: 5, max: 2 })).toMatchObject({ allowed: true });
  const accepted = await storage.get(key);
  expect(accepted).toMatchObject({ key, count: 2 });
  expect(accepted!.lastRequest).toBeGreaterThan(initial);
  // The original window would have elapsed, but the accepted request moved it.
  await setTimeout(750);
  expect(await storage.consume(key, { window: 5, max: 2 })).toMatchObject({ allowed: false });
  expect((await storage.get(key))!.lastRequest).toBe(accepted!.lastRequest);
  await expect
    .poll(async () => (await storage.consume(key, { window: 5, max: 2 })).allowed, {
      interval: 250,
      timeout: 6000,
    })
    .toBe(true);
}, 10_000);

it("keeps Better Auth's endpoint policy across a counter runtime restart", async () => {
  const path = await mkdtemp(join(tmpdir(), "mytuums-auth-rate-test-"));
  const database = await createTestDatabase();
  let persistent = createRuntime(path);
  const origin = "http://localhost:3001";
  const authFor = async () =>
    createAuth({
      db: database.db,
      origin,
      secret: "synthetic-auth-counter-secret-at-least-32-characters",
      sendEmail: () => Promise.resolve(),
      rateLimitEnabled: true,
      rateLimitStorage: await storageFor(persistent),
    });
  const request = () =>
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mytuums-client-ip": "192.0.2.19", origin },
      body: "{}",
    });
  try {
    const auth = await authFor();
    // Invalid bodies reach Better Auth's request limiter before validation,
    // without creating accounts or consuming password hashes/email transport.
    const responses = await Promise.all(Array.from({ length: 12 }, () => auth.handler(request())));
    expect(responses.filter((response) => response.status === 400)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
    await persistent.dispose();
    persistent = createRuntime(path);
    const restartedAuth = await authFor();
    const rejected = await restartedAuth.handler(request());
    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get("x-retry-after"))).toBeGreaterThan(0);
  } finally {
    await persistent.dispose();
    await database.dispose();
    await rm(path, { recursive: true, force: true });
  }
}, 20_000);
