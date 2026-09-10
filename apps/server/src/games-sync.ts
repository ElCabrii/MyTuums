/**
 * Runs one game-catalog sync against IGDB, then exits — the production
 * entrypoint of the `mytuums-games-sync` Railway cron service (issue #314,
 * Q13), and the production twin of the local `pnpm games:sync`.
 *
 *   node apps/server/dist/games-sync.js
 *
 * Talks to Postgres, the bucket and IGDB directly — no HTTP procedure, no
 * shared secret, nothing the serving app exposes. Reuses the ONE env schema
 * (`./env.ts`): a half IGDB pair or a partial S3 group fails here exactly
 * like it would at boot, instead of failing three minutes into a sync. The
 * cost is that the cron service must carry the serving env too
 * (BETTER_AUTH_* included) — one-time Railway toil, worth one schema.
 *
 * `DATABASE_URL` is already in the environment in Railway, so there is no
 * `dotenv` wrapper here — and there must not be one: the runner image
 * installs only production dependencies (issue #147). The work itself is
 * `syncGamesCatalog` in `@my-tuums/api/games-sync` — the same function the
 * local script calls, so the two paths cannot drift apart. It is fail-closed
 * by construction (issue Q28): every failure throws before or at the single
 * commit transaction, and the `catch` below turns that into `exit(1)` so
 * Railway marks the cron run FAILED and the previous catalog stands.
 *
 * Imports after `parseEnv` are dynamic on purpose (the `e2e/global-setup.ts`
 * pattern): a bad environment must fail HERE, not inside `@my-tuums/db`'s
 * module-scope `DATABASE_URL` throw with a less helpful message.
 */
import { parseEnv } from "./env.js";

// The one place `parseEnv`'s throw becomes `process.exit(1)` — the same
// contract as `src/index.ts`.
let env;
try {
  env = parseEnv(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

if (!env.IGDB_CLIENT_ID || !env.IGDB_CLIENT_SECRET) {
  console.error("IGDB_CLIENT_ID and IGDB_CLIENT_SECRET are both required to run a sync.");
  process.exit(1);
}

try {
  const [{ db, closeDb }, { createIgdbTransport, syncGamesCatalog }, { createStorage }] =
    await Promise.all([
      import("@my-tuums/db"),
      import("@my-tuums/api/games-sync"),
      import("@my-tuums/api/storage"),
    ]);

  // The whole S3_* group or none of it (`env.ts` refuses a partial group, so
  // no defensive middle case exists). Without a bucket the catalog still
  // syncs — covers keep their previous state and the run warns.
  const storage =
    env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? createStorage({
          endpoint: env.S3_ENDPOINT,
          bucket: env.S3_BUCKET,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          region: env.S3_REGION,
        })
      : null;

  const result = await syncGamesCatalog({
    db,
    storage,
    transport: createIgdbTransport(),
    clientId: env.IGDB_CLIENT_ID,
    clientSecret: env.IGDB_CLIENT_SECRET,
  });

  console.log(
    `games-sync: scanned ${result.scanned}, known ${result.knownIds}, new ${result.newGames}, ` +
      `covers uploaded ${result.coversUploaded} / kept ${result.coversKept} / failed ${result.coversFailed}.`,
  );
  await closeDb();
} catch (error) {
  // One structured line, not a stack trace: cron logs are scanned by humans
  // at 5 a.m. The reason taxonomy is IgdbError's, the message is whatever
  // stage threw it.
  console.error(
    JSON.stringify({
      source: "games-sync",
      reason: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
