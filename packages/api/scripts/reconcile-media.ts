import { parseArgs } from "node:util";
import { openPocMedia, POC_DATABASE_NAME, POC_MEDIA_BUCKET_NAME } from "@my-tuums/db/poc-database";
import { readMediaReferences } from "../src/media-intents.js";
import { reconcileMedia } from "../src/reconcile-media.js";
import { createR2Storage } from "../src/r2-storage.js";

const usage = `Usage: pnpm --filter @my-tuums/api reconcile:media --bucket=${POC_MEDIA_BUCKET_NAME} [--remote]`;
class ReconcileUsageError extends Error {}

function options() {
  try {
    const { values } = parseArgs({
      options: { bucket: { type: "string" }, remote: { type: "boolean", default: false } },
      allowPositionals: false,
    });
    if (values.bucket !== POC_MEDIA_BUCKET_NAME) throw new ReconcileUsageError(usage);
    return values;
  } catch {
    throw new ReconcileUsageError(usage);
  }
}

async function run() {
  const args = options();
  console.log(
    `Resources: ${POC_DATABASE_NAME} / ${POC_MEDIA_BUCKET_NAME} (${args.remote ? "remote" : "local"})`,
  );
  const platform = await openPocMedia(args.remote);
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
      : "PoC media reconciliation failed. Check Wrangler authentication, the PoC configuration and applied D1 migrations.",
  );
  process.exitCode = 1;
}
