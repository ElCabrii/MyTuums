import { parseArgs } from "node:util";
import { openPocMedia, POC_DATABASE_NAME, POC_MEDIA_BUCKET_NAME } from "@my-tuums/db/poc-database";
import { seedGamesFixture } from "../src/games-fixture.js";
import { createR2Storage } from "../src/r2-storage.js";

const usage = `Usage: pnpm games:seed --database=${POC_DATABASE_NAME} [--remote]`;
class SeedUsageError extends Error {}

function options() {
  try {
    const { values } = parseArgs({
      options: { database: { type: "string" }, remote: { type: "boolean", default: false } },
      allowPositionals: false,
    });
    if (values.database !== POC_DATABASE_NAME) throw new SeedUsageError(usage);
    return values;
  } catch {
    throw new SeedUsageError(usage);
  }
}

async function run() {
  const args = options();
  console.log(
    `Resources: ${POC_DATABASE_NAME} / ${POC_MEDIA_BUCKET_NAME} (${args.remote ? "remote" : "local"})`,
  );
  const platform = await openPocMedia(args.remote);
  try {
    const result = await seedGamesFixture({
      db: platform.db,
      storage: createR2Storage(platform.bucket),
    });
    console.log(`Seeded ${result.seeded} games (${result.coversUploaded} covers uploaded).`);
  } finally {
    await platform.dispose();
  }
}

try {
  await run();
} catch (error) {
  console.error(
    error instanceof SeedUsageError
      ? error.message
      : "PoC game seeding failed. Check Wrangler authentication, the PoC configuration and applied D1 migrations.",
  );
  process.exitCode = 1;
}
