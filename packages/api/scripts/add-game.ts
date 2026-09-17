import { parseArgs } from "node:util";
import {
  maintenanceResourceNames,
  openMaintenanceMedia,
  resolveMaintenanceEnvironment,
} from "@my-tuums/db/maintenance-environment";
import { addGameToCatalog, createIgdbTransport, UnknownIgdbGameError } from "../src/games-sync.js";
import { createR2Storage } from "../src/r2-storage.js";

const usage = "Usage: pnpm games:add <igdb-id> [--remote --environment=preview|production]";
class AddUsageError extends Error {}

function options() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        environment: { type: "string", default: "local" },
        remote: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
  } catch {
    throw new AddUsageError(usage);
  }
  const id = Number(parsed.positionals[0]);
  if (parsed.positionals.length !== 1 || !/^\d+$/.test(parsed.positionals[0] ?? "")) {
    throw new AddUsageError(usage);
  }
  if (!Number.isSafeInteger(id) || id <= 0) throw new AddUsageError(usage);
  return { id, remote: parsed.values.remote === true, environment: parsed.values.environment };
}

async function run() {
  const args = options();
  // The maintenance helper loads no .env; IGDB credentials arrive from the
  // shell like the jobs Worker's runtime secrets.
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AddUsageError(
      "IGDB_CLIENT_ID and IGDB_CLIENT_SECRET must be set in the environment.",
    );
  }

  const environment = resolveMaintenanceEnvironment(args.environment, args.remote);
  const resources = maintenanceResourceNames(environment);
  console.log(
    `Resources: ${resources.database} / ${resources.bucket} (${args.remote ? "remote" : "local"})`,
  );
  const platform = await openMaintenanceMedia(environment, args.remote);
  try {
    const result = await addGameToCatalog({
      db: platform.db,
      storage: createR2Storage(platform.bucket),
      transport: createIgdbTransport(),
      clientId,
      clientSecret,
      igdbId: args.id,
    });
    if (result.status === "already-present") {
      console.log(`igdb ${String(args.id)} (${result.name}) is already in the catalog.`);
      return;
    }
    console.log(
      `Added ${result.name} (#${result.hashtagKey})${result.coverUploaded ? " with cover" : " without a cover (the next daily sync uploads it)"}.`,
    );
  } finally {
    await platform.dispose();
  }
}

try {
  await run();
} catch (error) {
  console.error(
    error instanceof AddUsageError
      ? error.message
      : error instanceof UnknownIgdbGameError
        ? error.message
        : "Game add failed. Check Wrangler authentication, the selected environment, IGDB credentials and applied D1 migrations.",
  );
  process.exitCode = 1;
}
