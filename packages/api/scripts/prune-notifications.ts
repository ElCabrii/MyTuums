import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { openPocDatabase } from "@my-tuums/db/poc-database";
import { notification } from "@my-tuums/db/schema";
import { NOTIFICATION_RETENTION_DAYS } from "../src/constants.js";
import {
  pruneExpiredNotifications,
  withinNotificationRetention,
} from "../src/notification-retention.js";

const usage = `Usage: pnpm --filter @my-tuums/api prune:notifications --retention-days=${NOTIFICATION_RETENTION_DAYS} [--apply] [--remote]`;
class PruneUsageError extends Error {}

function options() {
  try {
    const { values } = parseArgs({
      options: {
        apply: { type: "boolean", default: false },
        remote: { type: "boolean", default: false },
        "retention-days": { type: "string" },
      },
      allowPositionals: false,
    });
    if (values["retention-days"] !== String(NOTIFICATION_RETENTION_DAYS))
      throw new PruneUsageError(usage);
    return values;
  } catch {
    throw new PruneUsageError(usage);
  }
}

async function run() {
  const args = options();
  console.log(`Database: mytuums-poc (${args.remote ? "remote" : "local"})`);
  const database = await openPocDatabase(args.remote);
  try {
    const [row] = await database.db
      .select({ count: sql<number>`count(*)` })
      .from(notification)
      .where(sql`not ${withinNotificationRetention()}`);
    console.log(
      `${row?.count ?? 0} notification rows past the ${NOTIFICATION_RETENTION_DAYS}-day horizon.`,
    );
    if (!args.apply) {
      console.log("Dry run — nothing deleted. Pass --apply to prune.");
      return;
    }
    // Use the scheduler's same bounded operation and retention predicate.
    // Moderation notices and read cursors never enter this deletion set.
    let deleted = 0;
    let more = true;
    while (more) {
      const batch = await pruneExpiredNotifications(database.db);
      deleted += batch.deletedCount;
      more = batch.hasMore;
    }
    console.log(`Deleted ${deleted} notification rows.`);
  } finally {
    await database.dispose();
  }
}

try {
  await run();
} catch (error) {
  console.error(
    error instanceof PruneUsageError
      ? error.message
      : "PoC notification pruning failed. Check Wrangler authentication, the PoC configuration and applied D1 migrations.",
  );
  process.exitCode = 1;
}
