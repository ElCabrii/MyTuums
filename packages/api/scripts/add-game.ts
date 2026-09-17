import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  maintenanceResourceNames,
  openMaintenanceMedia,
  resolveMaintenanceEnvironment,
} from "@my-tuums/db/maintenance-environment";
import { parseIgdbEnvCredentials } from "../src/igdb-credentials.js";
import { addGameToCatalog, createIgdbTransport, UnknownIgdbGameError } from "../src/games-sync.js";
import { createR2Storage } from "../src/r2-storage.js";

const usage = "Usage: pnpm games:add <igdb-id> [--remote --environment=preview|production]";
class AddUsageError extends Error {}

/** The repository root's `.env`, or empty text when the file does not exist. */
function readRootEnvFile(): string {
  try {
    return readFileSync(new URL("../../../.env", import.meta.url), "utf8");
  } catch {
    return "";
  }
}

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
  // Real environment first; otherwise exactly the two IGDB keys of the root
  // `.env` — never the whole file, whose DATABASE_URL/POSTGRES_* must not
  // reach a maintenance process. See src/igdb-credentials.ts.
  const fromFile = parseIgdbEnvCredentials(readRootEnvFile());
  const clientId = process.env.IGDB_CLIENT_ID ?? fromFile.clientId;
  const clientSecret = process.env.IGDB_CLIENT_SECRET ?? fromFile.clientSecret;
  if (!clientId || !clientSecret) {
    throw new AddUsageError(
      "IGDB_CLIENT_ID and IGDB_CLIENT_SECRET must be set in the environment or the root .env.",
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
