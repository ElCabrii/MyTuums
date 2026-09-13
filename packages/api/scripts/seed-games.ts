import { parseArgs } from "node:util";
import {
  maintenanceResourceNames,
  openMaintenanceMedia,
  resolveMaintenanceEnvironment,
} from "@my-tuums/db/maintenance-environment";
import { seedGamesFixture } from "../src/games-fixture.js";
import { createR2Storage } from "../src/r2-storage.js";

const usage = "Usage: pnpm games:seed [--remote --environment=preview|production]";
class SeedUsageError extends Error {}

function options() {
  try {
    const { values } = parseArgs({
      options: {
        environment: { type: "string", default: "local" },
        remote: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    return values;
  } catch {
    throw new SeedUsageError(usage);
  }
}

async function run() {
  const args = options();
  const remote = args.remote === true;
  const environment = resolveMaintenanceEnvironment(args.environment, remote);
  const resources = maintenanceResourceNames(environment);
  console.log(
    `Resources: ${resources.database} / ${resources.bucket} (${remote ? "remote" : "local"})`,
  );
  const platform = await openMaintenanceMedia(environment, remote);
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
      : "Game seeding failed. Check Wrangler authentication, the selected environment and applied D1 migrations.",
  );
  process.exitCode = 1;
}
