/**
 * Seeds the game catalog from the committed fixture (issue #314, Q27) — the
 * dev/CI/e2e data source. The real catalog comes from the IGDB sync
 * (`pnpm games:sync`); this file exists so those environments never need
 * IGDB credentials.
 *
 * THE GUARD IS THE POINT (the `--database=` retype, the same instinct as
 * `reconcile-media.ts`'s `--bucket=`): a seed is harmless against a dev or
 * test database and pure noise against production, and nothing in the
 * environment alone tells them apart — production's database name is unknown
 * to this repo, so an allowlist would be theater. Requiring the operator to
 * retype the target's name makes the target a deliberate choice.
 *
 *   pnpm games:seed --database mytuums_dev
 *
 * Covers upload only when the whole S3_* group is present; without a bucket
 * the catalog seeds bare (see `seedGamesFixture`).
 *
 * A later REAL sync against the same database is fine: the sync upserts by
 * IGDB id and the fixture's synthetic ids (900001+) never collide with real
 * ones — the fixture rows simply persist as dropouts (issue Q29's
 * never-delete). Wipe them first with a plain `delete from game` if that
 * bothers a dev catalog.
 */
import { closeDb, db } from "@my-tuums/db";
import { createStorage, type Storage } from "@my-tuums/api/storage";
import { seedGamesFixture } from "@my-tuums/api/games-sync";

// Both `--database=name` and `--database name` spellings, so the retype
// never fails on an equals sign.
const databaseArg =
  process.argv.find((arg) => arg.startsWith("--database="))?.slice("--database=".length) ??
  (process.argv.includes("--database")
    ? process.argv[process.argv.indexOf("--database") + 1]
    : undefined);

if (!process.env.DATABASE_URL) {
  console.error("Refusing to run: DATABASE_URL is unset.");
  process.exit(1);
}
if (!databaseArg) {
  console.error(
    "Refusing to run: pass --database=<name> (the target database's name, retyped deliberately).",
  );
  process.exit(1);
}

const targetName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, "");
if (databaseArg !== targetName) {
  console.error(
    `Refusing to run: --database=${databaseArg} but DATABASE_URL points at ${targetName}.`,
  );
  process.exit(1);
}

// The storage group is all-or-nothing, the same rule `context.ts` applies.
const s3 = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
const s3Present = s3.filter((key) => process.env[key]);
if (s3Present.length > 0 && s3Present.length < s3.length) {
  console.error(
    `Refusing to run: image uploads need the whole S3_* group or none of it (missing: ${s3.filter((key) => !process.env[key]).join(", ")}).`,
  );
  process.exit(1);
}
const storage: Storage | null =
  s3Present.length === s3.length
    ? createStorage({
        endpoint: process.env.S3_ENDPOINT!,
        bucket: process.env.S3_BUCKET!,
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      })
    : null;

const result = await seedGamesFixture({ db, storage });
console.log(
  `Seeded ${result.seeded} games${storage ? ` (${result.coversUploaded} covers uploaded)` : " (no bucket configured — covers skipped)"}.`,
);
await closeDb();
