import { parseArgs } from "node:util";
import { z } from "zod";
import { openPocDatabase, POC_DATABASE_NAME } from "@my-tuums/db/poc-database";
import { jobIntentInsert } from "@my-tuums/api/cloudflare-jobs";

const usage = "Usage: pnpm games:sync [--remote]";
class SyncUsageError extends Error {}

function options() {
  try {
    return parseArgs({
      options: { remote: { type: "boolean", default: false } },
      allowPositionals: false,
    }).values;
  } catch {
    throw new SyncUsageError(usage);
  }
}

async function run() {
  const args = options();
  const database = await openPocDatabase(args.remote);
  try {
    // The database clock supplies the same 13-digit entity format consumed by
    // GameSyncWorkflow. Its staged publisher fences older concurrent runs.
    const scheduledAt = z
      .number()
      .int()
      .min(1_000_000_000_000)
      .max(9_999_999_999_999)
      .parse(
        await database.db.$client
          .prepare("select cast(unixepoch('subsec') * 1000 as integer) as scheduled_at")
          .first<number>("scheduled_at"),
      );
    const id = `games-${scheduledAt}`;
    await jobIntentInsert(database.db, { id, kind: "game-sync", entityId: id });
    console.log(`Queued ${id} in ${POC_DATABASE_NAME} (${args.remote ? "remote" : "local"}).`);
    console.log(
      "The jobs Worker's scheduled recovery dispatches this request. Queued does not mean completed.",
    );
  } finally {
    await database.dispose();
  }
}

try {
  await run();
} catch (error) {
  console.error(
    error instanceof SyncUsageError
      ? error.message
      : "PoC game sync request failed. Check Wrangler authentication, the PoC configuration and applied D1 migrations.",
  );
  process.exitCode = 1;
}
