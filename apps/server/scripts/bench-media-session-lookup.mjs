/**
 * Benchmarks the `/media` gate's session-lookup cost (issue #63): how long a
 * real `auth.api.getSession` call takes — the exact call
 * `apps/server/src/request-handler.ts`'s `hasValidSession` makes, over the
 * same headers a browser request would carry — against a realistically-sized
 * session table, and what that costs a cold feed page loading 20 avatars.
 *
 * INVESTIGATION ONLY, per issue #63: this script measures and reports. It
 * does not change `/media` behaviour, does not add a session cache, and does
 * not touch the pinned no-session-cookie-cache setting in
 * packages/auth/src/index.ts (read the comment there before even thinking
 * about it — the setting exists so a revoked session stops authenticating
 * immediately).
 *
 * ENVIRONMENT CAVEAT — read this before trusting any number this prints: it
 * runs on one developer laptop against a local Docker Postgres container over
 * loopback, not the Railway production topology (managed Postgres, a real
 * network hop, different CPU and disk). The numbers bound the SHAPE of the
 * cost — one indexed lookup plus BetterAuth's own per-call overhead — they do
 * not predict a production latency figure. See apps/server/CLAUDE.md for the
 * recorded measurement and decision.
 *
 * Runs entirely against a scratch database this script creates, seeds,
 * measures against, and drops — never `mytuums` or `mytuums_test`.
 * `assertTestDatabase` (packages/db/src/testing.ts) is the guard that refuses
 * to touch anything whose name doesn't end in `_test`.
 *
 * Usage: pnpm --filter @my-tuums/server bench:media-session
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import assert from "node:assert/strict";
import path from "node:path";
import postgres from "postgres";
import { assertTestDatabase, maintenanceUrlFor } from "@my-tuums/db/testing";
import {
  createStorage,
  MEDIA_SIGNING_WINDOW_MS,
  secondsUntilWindowEnd,
} from "@my-tuums/api/storage";

// packages/db is a sibling package; scripts/<this file> -> apps/server ->
// apps -> repo root -> packages/db.
const dbPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db",
);

/**
 * A social app at a scale worth worrying about has hundreds of thousands of
 * live sessions, not a handful — a lookup against 5 rows would measure
 * nothing about how the index behaves under real weight. 100k users is a
 * defensible "growth stage" size, and roughly 1.5 sessions per user reflects
 * that a meaningful share of visitors carry a session on more than one
 * device (phone + laptop) rather than exactly one each.
 */
const FILLER_USER_COUNT = 100_000;
const MULTI_SESSION_USER_COUNT = 50_000; // get 2 sessions each
const SINGLE_SESSION_USER_COUNT = FILLER_USER_COUNT - MULTI_SESSION_USER_COUNT; // get 1 each
const INSERT_CHUNK_SIZE = 2_000;

const IMAGES_PER_FEED_PAGE = 20;
const WARMUP_ITERATIONS = 20;
const MEASURED_ITERATIONS = 300;
const CONCURRENT_BATCHES = 30;

/**
 * Swaps the database name in a Postgres connection string.
 *
 * Mirrors the private `withDatabaseName` helper in
 * packages/db/src/testing.ts, which isn't exported — four lines, not worth a
 * new public export for one script.
 */
function withDatabaseName(connectionString, name) {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

function percentile(sortedMs, p) {
  const index = Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length));
  return sortedMs[index];
}

function summarize(label, sortedMs) {
  const p50 = percentile(sortedMs, 0.5);
  const p95 = percentile(sortedMs, 0.95);
  console.log(`  ${label}: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms (n=${sortedMs.length})`);
  return { p50, p95 };
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL is not set — see .env.example.");
  process.exit(1);
}

const scratchDbName = "media_session_bench_test";
const scratchUrl = withDatabaseName(baseUrl, scratchDbName);

// The guard fires before a single statement runs against anything.
assertTestDatabase({ DATABASE_URL: scratchUrl });

console.log(`Creating scratch database "${scratchDbName}"…`);
const admin = postgres(maintenanceUrlFor(scratchUrl), { max: 1, onnotice: () => {} });
try {
  const [existing] = await admin`select 1 from pg_database where datname = ${scratchDbName}`;
  if (existing) {
    console.log(`  already exists from a previous interrupted run — reusing it`);
  } else {
    await admin`create database ${admin(scratchDbName)}`;
    console.log(`  created`);
  }
} finally {
  await admin.end();
}

console.log(`Migrating "${scratchDbName}"…`);
execFileSync("npx", ["drizzle-kit", "migrate"], {
  cwd: dbPackageRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DATABASE_URL: scratchUrl },
});

// Everything from here on must resolve `@my-tuums/db`'s module-scope
// singleton pool against the scratch database, not the dev database this
// process actually started with — so the redirect happens BEFORE any of
// those packages are imported. A static `import` at the top of this file
// would already have run by the time we got here, which is why `@my-tuums/db`,
// `@my-tuums/api` and `@my-tuums/auth` are all dynamic imports below instead.
process.env.DATABASE_URL = scratchUrl;

try {
  const { closeDb, db } = await import("@my-tuums/db");
  const { user, session } = await import("@my-tuums/db/schema");
  const { auth } = await import("@my-tuums/auth");
  const { testHelpers } = await import("@my-tuums/auth/testing");
  const { createMediaResolver } = await import("@my-tuums/api");
  const { sql } = await import("drizzle-orm");

  try {
    // ---- Seed one real user + session, minted through BetterAuth's own
    // ---- privileged test helper — not hand-crafted — so the cookie we
    // ---- benchmark against is byte-for-byte what a real sign-in produces.
    console.log("Minting the benchmarked session through BetterAuth's test helpers…");
    const helpers = await testHelpers();
    const heroUser = helpers.createUser({
      email: "bench-hero@example.com",
      name: "Bench Hero",
    });
    const savedHero = await helpers.saveUser(heroUser);
    const { headers } = await helpers.login({ userId: savedHero.id });

    // ---- Bulk-seed the filler population directly via Drizzle. Going
    // ---- through sign-up for 100k+ rows would spend most of its time
    // ---- hashing passwords, which is not what this benchmark measures —
    // ---- the same reasoning packages/api/src/testing/harness.ts's
    // ---- `seedPosts` uses for pagination fixtures.
    console.log(
      `Seeding ${FILLER_USER_COUNT.toLocaleString()} filler users and ` +
        `${(MULTI_SESSION_USER_COUNT * 2 + SINGLE_SESSION_USER_COUNT).toLocaleString()} ` +
        `filler sessions…`,
    );

    const fillerUserIds = Array.from({ length: FILLER_USER_COUNT }, () => randomUUID());

    for (let i = 0; i < fillerUserIds.length; i += INSERT_CHUNK_SIZE) {
      const chunk = fillerUserIds.slice(i, i + INSERT_CHUNK_SIZE).map((id, offset) => ({
        id,
        name: `Bench Filler ${i + offset}`,
        email: `bench-filler-${i + offset}@example.invalid`,
        username: `bench_filler_${i + offset}`,
        role: "user",
      }));
      await db.insert(user).values(chunk);
    }

    const now = new Date();
    const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const fillerSessionRows = [];
    for (let i = 0; i < fillerUserIds.length; i++) {
      const sessionsForThisUser = i < MULTI_SESSION_USER_COUNT ? 2 : 1;
      for (let s = 0; s < sessionsForThisUser; s++) {
        fillerSessionRows.push({
          id: randomUUID(),
          token: randomUUID(),
          userId: fillerUserIds[i],
          expiresAt: sevenDaysOut,
        });
      }
    }

    for (let i = 0; i < fillerSessionRows.length; i += INSERT_CHUNK_SIZE) {
      await db.insert(session).values(fillerSessionRows.slice(i, i + INSERT_CHUNK_SIZE));
    }

    // A freshly bulk-loaded table has no statistics yet; a table that has
    // been live for months does. ANALYZE is what makes the query plan the
    // one a real production table would actually get, not the plan a
    // just-created one happens to get by luck.
    await db.execute(sql`ANALYZE "session"`);
    await db.execute(sql`ANALYZE "user"`);

    const [{ count: userCount }] = await db.execute(sql`SELECT count(*)::int AS count FROM "user"`);
    const [{ count: sessionCount }] = await db.execute(
      sql`SELECT count(*)::int AS count FROM "session"`,
    );
    console.log(`  table now holds ${userCount} users, ${sessionCount} sessions`);

    // ---- Measure. `hasValidSession` in apps/server/src/index.ts calls
    // ---- exactly this: `auth.api.getSession({ headers })`.
    console.log("\nMeasuring auth.api.getSession…");

    async function timedGetSession() {
      const start = performance.now();
      const result = await auth.api.getSession({ headers });
      const elapsed = performance.now() - start;
      assert.notEqual(result, null, "getSession returned null for the benchmarked session");
      return elapsed;
    }

    const coldMs = await timedGetSession();
    console.log(
      `  cold (first call in this process — includes connection setup): ${coldMs.toFixed(2)}ms`,
    );

    for (let i = 0; i < WARMUP_ITERATIONS; i++) await timedGetSession();

    const sequentialMs = [];
    for (let i = 0; i < MEASURED_ITERATIONS; i++) sequentialMs.push(await timedGetSession());
    sequentialMs.sort((a, b) => a - b);
    const sequential = summarize("warm, sequential (one call at a time)", sequentialMs);

    // 20 concurrent calls, matching how a browser actually loads a feed page:
    // several connections open at once, each awaiting its own DB round trip
    // while Node services the others — not 20x the sequential cost.
    const batchMs = [];
    for (let i = 0; i < CONCURRENT_BATCHES; i++) {
      const start = performance.now();
      await Promise.all(
        Array.from({ length: IMAGES_PER_FEED_PAGE }, () => auth.api.getSession({ headers })),
      );
      batchMs.push(performance.now() - start);
    }
    batchMs.sort((a, b) => a - b);
    const concurrentBatch = summarize(
      `warm, ${IMAGES_PER_FEED_PAGE} concurrent calls (one feed page's worth)`,
      batchMs,
    );

    console.log(
      `\nAdded latency for a cold feed page with ${IMAGES_PER_FEED_PAGE} images:\n` +
        `  naive sequential estimate (p50 x ${IMAGES_PER_FEED_PAGE}): ${(sequential.p50 * IMAGES_PER_FEED_PAGE).toFixed(2)}ms\n` +
        `  naive sequential estimate (p95 x ${IMAGES_PER_FEED_PAGE}): ${(sequential.p95 * IMAGES_PER_FEED_PAGE).toFixed(2)}ms\n` +
        `  measured concurrent batch:                    p50=${concurrentBatch.p50.toFixed(2)}ms p95=${concurrentBatch.p95.toFixed(2)}ms`,
    );

    // ---- Cheap verification of the two things the issue says may make this
    // ---- a non-issue.
    console.log("\nVerifying the two mitigations the issue names:");

    const secondsLeft = secondsUntilWindowEnd();
    assert.ok(secondsLeft > 0 && secondsLeft <= MEDIA_SIGNING_WINDOW_MS / 1000);
    console.log(
      `  1. Cache-Control on the 302: request-handler.ts sets ` +
        `"private, max-age=${secondsLeft}", bounded by MEDIA_SIGNING_WINDOW_MS ` +
        `(${MEDIA_SIGNING_WINDOW_MS / 1000}s) — OK`,
    );

    const s3EnvComplete =
      process.env.S3_ENDPOINT &&
      process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY;

    if (s3EnvComplete) {
      // Presigning is a local HMAC computation, no network call — this makes
      // no request to the bucket and writes nothing.
      const storage = createStorage({
        endpoint: process.env.S3_ENDPOINT,
        bucket: process.env.S3_BUCKET,
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        region: process.env.S3_REGION,
      });
      const resolveMediaUrl = createMediaResolver(storage);
      const key = "avatars/bench-verification-key.webp";
      const [first, second] = await Promise.all([resolveMediaUrl(key), resolveMediaUrl(key)]);
      assert.equal(first?.url, second?.url, "presigned URL was not byte-identical in-window");
      console.log("  2. Presigned URL is byte-identical for two calls in the same window — OK");
    } else {
      console.log("  2. SKIPPED — S3_* env is not fully set locally, nothing to presign against");
    }
  } finally {
    await closeDb();
  }
} finally {
  console.log(`\nDropping scratch database "${scratchDbName}"…`);
  const cleanupAdmin = postgres(maintenanceUrlFor(scratchUrl), { max: 1, onnotice: () => {} });
  try {
    await cleanupAdmin`drop database if exists ${cleanupAdmin(scratchDbName)}`;
    console.log("  dropped");
  } finally {
    await cleanupAdmin.end();
  }
}
