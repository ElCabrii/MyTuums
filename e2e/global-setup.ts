import { assertTestDatabase, resolveTestDatabaseUrl } from "@my-tuums/db/testing";

/**
 * Runs once per `playwright test` invocation, before any test — including
 * the `setup` project that signs up alice/bob — executes. (It runs *after*
 * the `webServer` processes in playwright.config.ts have already been
 * started and are pointed at the test database via `stackEnv`; Playwright
 * starts webServer as a "plugin" ahead of globalSetup. That ordering is
 * harmless here: nothing has made a request yet, so emptying the tables a
 * moment after the servers come up is indistinguishable from emptying them
 * a moment before.)
 *
 * `@my-tuums/db` reads `DATABASE_URL` at module scope and throws if it's
 * unset (packages/db/src/index.ts). The `e2e` script runs under
 * `dotenv -e ../.env`, so by the time this file starts, `DATABASE_URL`
 * already holds the *dev* database's connection string — this process never
 * saw the test-only override that playwright.config.ts computes for the
 * child server processes. The dynamic `import()` below is what makes the
 * fix work: the assignment has to land before `@my-tuums/db` is evaluated,
 * and a static top-of-file `import` is hoisted above every other statement
 * in this module, so it would run — and throw against the wrong database —
 * before a plain assignment ever got a chance to.
 *
 * The cleanup itself is delegated to `truncateAll` in `./support/db`, which
 * is also the per-spec cleanup helper specs call for a guaranteed-clean
 * slate. Delegating keeps one truncate statement instead of two that could
 * drift apart, and it is what makes the bucket purge run: `truncateAll`
 * truncates every table — the `twoFactor` and `passkey` tables included,
 * which a hand-maintained list would have to remember to keep adding — and
 * then deletes every object the suite's earlier runs uploaded to the dev/ci
 * bucket, so avatars and banners do not accumulate between runs (that purge
 * used to be dead code: nothing called `truncateAll`, and the inline
 * truncate here never touched the bucket). The purge is best-effort by
 * design: an unreachable bucket, or a run with no `S3_*` group at all, must
 * not fail a suite whose subject is the database (the upload specs are
 * skipped in that configuration anyway).
 */
export default async function globalSetup(): Promise<void> {
  process.env.DATABASE_URL = resolveTestDatabaseUrl();

  // The guard that stands between this file and the dev database: refuses to
  // proceed unless the database name it just computed ends in `_test`.
  assertTestDatabase();

  // Both dynamic, and both after the assignment above: `./support/db`
  // re-derives its own URL guardedly at module scope, and `@my-tuums/db`
  // reads `DATABASE_URL` at module scope — either one evaluated earlier
  // would hit the dev database. `closeDb` drains the pool `truncateAll`
  // opened, the same drain the inline truncate used to do here.
  const [{ truncateAll }, { db, closeDb }] = await Promise.all([
    import("./support/db"),
    import("@my-tuums/db"),
  ]);

  try {
    await truncateAll();
    // Then the game catalog from the committed fixture (issue #314): the
    // truncate above emptied `game` with everything else, and specs that
    // assert against game data (pages, search, hashtag resolution) read
    // THIS catalog, not one they seeded themselves — it is reference data,
    // stable across the whole run by construction. Covers upload only when
    // the S3_* group is present (fork PRs and bucket-less dev machines seed
    // a bare catalog; the upload specs are skipped in that configuration
    // anyway).
    const { seedGamesFixture } = await import("@my-tuums/api/games-sync");
    const storage = s3Configured()
      ? (await import("@my-tuums/api/storage")).createStorage({
          endpoint: process.env.S3_ENDPOINT!,
          bucket: process.env.S3_BUCKET!,
          accessKeyId: process.env.S3_ACCESS_KEY_ID!,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
        })
      : null;
    await seedGamesFixture({ db, storage });
  } finally {
    await closeDb();
  }
}

/** The whole S3_* group or none of it — the same rule `context.ts` applies. */
function s3Configured(): boolean {
  return Boolean(
    process.env.S3_ENDPOINT &&
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY,
  );
}
