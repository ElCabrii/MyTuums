import { ORPCError } from "@orpc/server";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import type { Database } from "@my-tuums/db";
import type { EmailLocale } from "@my-tuums/auth";
import { appeal, moderationAction, report, session, user } from "@my-tuums/db/schema";
import { canManageRole, roleRank, USER_ROLES, type UserRole } from "./roles.js";
import { notificationInsert } from "./notification-writer.js";
import { moderationEmailInsert } from "./moderation-email.js";

type UserModeration = {
  userId: string;
  actorId: string;
  actorRole: string;
  closeAppeals?: boolean;
  emailLocale?: EmailLocale;
} & (
  | { operation: "suspend"; reason: string; durationSeconds: number }
  | { operation: "ban"; reason: string }
  | { operation: "unban"; note?: string; tolerateNotBanned?: boolean }
  | { operation: "role"; role: UserRole }
  | { operation: "restoreRole"; grantedRole: string; oldRole: string }
);

/** Account state, its audit/notice and dependent cleanup share one D1 commit. */
export function userModerationStatements(db: Database, args: UserModeration, when?: SQL) {
  const actionId = crypto.randomUUID();
  // Use the role catalog itself, preserving the -1 rank for unknown roles.
  const manageable = sql`${roleRank(args.actorRole)} > coalesce((
    select key from json_each(${JSON.stringify(USER_ROLES)})
    where value = coalesce(${user.role}, 'user')
  ), -1)`;
  let permitted: SQL = manageable;
  let action: SQL;
  let details: SQL = sql`'{}'`;
  switch (args.operation) {
    case "suspend":
      permitted = sql`${manageable} and not (coalesce(${user.banned}, 0) and ${user.banExpires} is null)`;
      action = sql`'user_suspended'`;
      details = sql`json_object('durationSeconds', ${args.durationSeconds})`;
      break;
    case "ban":
      action = sql`'user_banned'`;
      break;
    case "unban":
      permitted = sql`${manageable} and ${user.banned}`;
      action = sql`case when ${user.banExpires} is null then 'user_unbanned' else 'user_unsuspended' end`;
      break;
    case "role":
      permitted = sql`${manageable} and ${user.role} is not ${args.role}`;
      action = sql`'role_changed'`;
      details = sql`json_object('oldRole', coalesce(${user.role}, 'user'), 'newRole', ${args.role})`;
      break;
    case "restoreRole":
      permitted = sql`${manageable} and ${user.role} = ${args.grantedRole}
        and ${canManageRole(args.actorRole, args.oldRole) ? 1 : 0}`;
      action = sql`'role_changed'`;
      details = sql`json_object('oldRole', coalesce(${user.role}, 'user'), 'newRole', ${args.oldRole})`;
      break;
  }
  const target = and(eq(user.id, args.userId), permitted, when);
  const applied = sql`exists (select 1 from ${moderationAction} where ${moderationAction.id} = ${actionId})`;
  const snapshot = db
    .select({ id: user.id, role: user.role, banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, args.userId));
  const statements: BatchItem<"sqlite">[] = [];
  if (args.closeAppeals) {
    const family =
      args.operation === "role" || args.operation === "restoreRole"
        ? ["role_changed"]
        : ["user_suspended", "user_banned"];
    statements.push(
      db
        .update(appeal)
        .set({
          status:
            args.operation === "suspend" || args.operation === "ban" ? "superseded" : "reversed",
        })
        .where(
          and(
            eq(appeal.status, "open"),
            sql`${appeal.actionId} in (
      select ${moderationAction.id} from ${moderationAction}
      where ${moderationAction.targetType} = 'user' and ${moderationAction.targetUserId} = ${args.userId}
      and ${moderationAction.action} in (select value from json_each(${JSON.stringify(family)}))
    )`,
            sql`exists (select 1 from ${user} where ${target})`,
          ),
        ),
    );
  }
  // INSERT SELECT follows every moderation_action column in schema order.
  // Capture old role/expiry before changing the row so the audit is truthful.
  statements.push(
    db.insert(moderationAction).select(sql`select ${actionId}, ${action}, ${args.actorId},
    'user', null, ${args.userId}, ${"reason" in args ? args.reason : null},
    ${"note" in args ? (args.note ?? null) : null}, ${details}, cast(unixepoch('subsec') * 1000 as integer)
    from ${user} where ${target}`),
  );
  const notice = notificationInsert(
    db,
    {
      recipientId: args.userId,
      actorId: null,
      type: "moderation",
      actionId,
    },
    applied,
  );
  if (notice) statements.push(notice);
  if (args.operation === "suspend" || args.operation === "ban") {
    statements.push(db.delete(session).where(and(eq(session.userId, args.userId), applied)));
    statements.push(
      db
        .update(report)
        .set({
          resolvedAt: sql`cast(unixepoch('subsec') * 1000 as integer)`,
          resolvedBy: args.actorId,
          resolvedOutcome: "actioned",
          resolutionNote: args.reason,
        })
        .where(
          and(
            eq(report.targetType, "user"),
            eq(report.targetId, args.userId),
            sql`${report.resolvedAt} is null`,
            applied,
          ),
        ),
    );
    statements.push(
      db
        .update(user)
        .set({
          banned: true,
          banReason: args.reason,
          banExpires:
            args.operation === "suspend"
              ? sql`(select ${moderationAction.createdAt} + ${args.durationSeconds * 1000}
            from ${moderationAction} where ${moderationAction.id} = ${actionId})`
              : null,
        })
        .where(and(eq(user.id, args.userId), applied)),
    );
  } else if (args.operation === "unban") {
    statements.push(
      db
        .update(user)
        .set({ banned: false, banReason: null, banExpires: null })
        .where(and(eq(user.id, args.userId), applied)),
    );
  } else {
    statements.push(
      db
        .update(user)
        .set({ role: args.operation === "role" ? args.role : args.oldRole })
        .where(and(eq(user.id, args.userId), applied)),
    );
  }
  let emailContent: SQL;
  switch (args.operation) {
    case "suspend":
      emailContent = sql`json_object('kind', 'user_suspended', 'reason', ${args.reason},
        'expiresAt', ${user.banExpires})`;
      break;
    case "ban":
      emailContent = sql`json_object('kind', 'user_banned', 'reason', ${args.reason})`;
      break;
    case "unban":
      emailContent = sql`json_object('kind', (select ${moderationAction.action}
        from ${moderationAction} where ${moderationAction.id} = ${actionId}))`;
      break;
    case "role":
    case "restoreRole":
      emailContent = sql`json_object('kind', 'role_changed', 'role', ${user.role}, 'reason', null)`;
      break;
  }
  // Read the stored expiry/role after the guarded mutation in this same batch.
  statements.push(
    moderationEmailInsert(
      db,
      {
        sourceId: actionId,
        recipients: sql`select ${args.userId}`,
        fallbackLocale: args.emailLocale ?? "en",
        content: emailContent,
      },
      applied,
    ),
  );
  const result = db
    .select({ banExpires: user.banExpires })
    .from(user)
    .where(and(eq(user.id, args.userId), applied));
  return { snapshot, statements, result, actionId };
}

export async function moderateUser(db: Database, args: UserModeration) {
  const plan = userModerationStatements(db, args);
  const [targets, ...effects] = await db.batch([plan.snapshot, ...plan.statements, plan.result]);
  const target = targets[0];
  if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });
  // Parse the final projection after the heterogeneous statement list. Its
  // stored expiry is the authority for both the caller and suspension email.
  const updated = z.array(z.object({ banExpires: z.date().nullable() })).parse(effects.at(-1));
  const result = {
    target,
    actionId: plan.actionId,
    changed: updated.length !== 0,
    banExpires: updated[0]?.banExpires ?? null,
  };
  if (args.operation === "restoreRole" && target.role !== args.grantedRole) return result;
  if (args.operation === "unban" && !target.banned) {
    if (args.tolerateNotBanned) return result;
    throw new ORPCError("BAD_REQUEST", { message: "This account isn't banned or suspended." });
  }
  if (
    !canManageRole(args.actorRole, target.role ?? "user") ||
    (args.operation === "restoreRole" && !canManageRole(args.actorRole, args.oldRole))
  )
    throw new ORPCError("FORBIDDEN");
  if (args.operation === "suspend" && target.banned && !target.banExpires)
    throw new ORPCError("BAD_REQUEST", {
      message: "This account is permanently banned. Unban it before suspending.",
    });
  if (args.operation === "role" && target.role === args.role)
    throw new ORPCError("BAD_REQUEST", { message: "This account already has that role." });
  return result;
}
