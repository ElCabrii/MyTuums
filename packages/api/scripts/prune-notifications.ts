/**
 * Prunes notifications past the retention horizon
 * (`NOTIFICATION_RETENTION_DAYS` in src/constants.ts — the same boundary the
 * list and the badge already serve, so what this deletes is exactly what the
 * app has already stopped showing).
 *
 * Moderation rows are exempt: they are rare, individually meaningful, and
 * mirror an audit row that lives forever — a returning user finding their
 * year-old ban notice intact is worth a handful of retained rows. Read
 * cursors older than the horizon go with their rows.
 *
 * Dry-run by default; `--apply` deletes. The retention-days flag is the arm
 * switch, deliberately explicit and deliberately checked against the
 * constant — a number typed from memory here and drifted there would prune a
 * different history than the app serves.
 *
 *   pnpm --filter @my-tuums/api prune:notifications                    # report
 *   pnpm --filter @my-tuums/api prune:notifications --apply --retention-days=90
 */
import { lt, sql, and, ne } from "drizzle-orm";
import { closeDb, db } from "@my-tuums/db";
import { notification, notificationLastSeen } from "@my-tuums/db/schema";
import { NOTIFICATION_RETENTION_DAYS } from "../src/constants.ts";

const apply = process.argv.includes("--apply");
const retentionArg = process.argv
  .find((arg) => arg.startsWith("--retention-days="))
  ?.slice("--retention-days=".length);

if (retentionArg === undefined) {
  console.error(
    "Refusing to run: pass --retention-days=<n> (must equal NOTIFICATION_RETENTION_DAYS).",
  );
  process.exit(1);
}
if (Number(retentionArg) !== NOTIFICATION_RETENTION_DAYS) {
  console.error(
    `Refusing to run: --retention-days=${retentionArg} but NOTIFICATION_RETENTION_DAYS is ${NOTIFICATION_RETENTION_DAYS}. ` +
      "The prune must not drift from the horizon the app serves.",
  );
  process.exit(1);
}

const horizon = sql`now() - make_interval(days => ${NOTIFICATION_RETENTION_DAYS})`;

const expired = and(lt(notification.createdAt, horizon), ne(notification.type, "moderation"));

const [countRow] = await db
  .select({ count: sql<number>`count(*)::int` })
  .from(notification)
  .where(expired);
console.log(
  `${countRow?.count ?? 0} notification rows past the ${NOTIFICATION_RETENTION_DAYS}-day horizon.`,
);

if (!apply) {
  console.log("Dry run — nothing deleted. Pass --apply to prune.");
} else {
  const deleted = await db.delete(notification).where(expired).returning({ id: notification.id });
  const cursors = await db
    .delete(notificationLastSeen)
    .where(lt(notificationLastSeen.seenAt, horizon))
    .returning({ recipientId: notificationLastSeen.recipientId });
  console.log(`Deleted ${deleted.length} notification rows, ${cursors.length} stale read cursors.`);
}

await closeDb();
