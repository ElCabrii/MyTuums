import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import {
  maintenanceResourceNames,
  openMaintenanceDatabase,
  resolveMaintenanceEnvironment,
} from "@my-tuums/db/maintenance-environment";
import { notification } from "@my-tuums/db/schema";
import { NOTIFICATION_RETENTION_DAYS } from "../src/constants.js";
import {
  pruneExpiredNotifications,
  withinNotificationRetention,
} from "../src/notification-retention.js";

const usage = `Usage: pnpm --filter @my-tuums/api prune:notifications --retention-days=${NOTIFICATION_RETENTION_DAYS} [--apply] [--remote --environment=preview|production]`;
class PruneUsageError extends Error {}

function options() {
  try {
    const { values } = parseArgs({
      options: {
        apply: { type: "boolean", default: false },
        remote: { type: "boolean", default: false },
        environment: { type: "string", default: "local" },
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
  const remote = args.remote === true;
  const environment = resolveMaintenanceEnvironment(args.environment, remote);
  console.log(
    `Database: ${maintenanceResourceNames(environment).database} (${remote ? "remote" : "local"})`,
  );
  const database = await openMaintenanceDatabase(environment, remote);
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
      : "Notification pruning failed. Check Wrangler authentication, the selected environment and applied D1 migrations.",
  );
  process.exitCode = 1;
}
