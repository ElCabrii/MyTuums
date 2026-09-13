import { parseArgs } from "node:util";
import {
  maintenanceResourceNames,
  openMaintenanceMedia,
  resolveMaintenanceEnvironment,
} from "@my-tuums/db/maintenance-environment";
import { readMediaReferences } from "../src/media-intents.js";
import { reconcileMedia } from "../src/reconcile-media.js";
import { createR2Storage } from "../src/r2-storage.js";

const usage =
  "Usage: pnpm --filter @my-tuums/api reconcile:media [--remote --environment=preview|production]";
class ReconcileUsageError extends Error {}

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
    throw new ReconcileUsageError(usage);
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
    // The existing reconciliation operation lists every managed prefix before
    // reading live and pending D1 references. Preserve that ordering here.
    const { listed, deleted } = await reconcileMedia({
      storage: createR2Storage(platform.bucket),
      readReferences: () => readMediaReferences(platform.db),
    });
    console.log(`Done: listed ${listed}, deleted ${deleted}, kept ${listed - deleted}.`);
  } finally {
    await platform.dispose();
  }
}

try {
  await run();
} catch (error) {
  console.error(
    error instanceof ReconcileUsageError
      ? error.message
      : "Media reconciliation failed. Check Wrangler authentication, the selected environment and applied D1 migrations.",
  );
  process.exitCode = 1;
}
