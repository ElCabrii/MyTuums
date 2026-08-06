import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import {
  localeFromRequest,
  moderationRestoreEmail,
  moderationRoleEmail,
  moderationUnbanEmail,
  moderationUnsuspensionEmail,
  sendEmail,
  webOrigin,
  type EmailLocale,
  type OutgoingEmail,
} from "@my-tuums/auth";
import { type Database } from "@my-tuums/db";
import { moderationAction, post, report, user } from "@my-tuums/db/schema";
import { appealToken } from "./appeal-token.js";

/**
 * The shared effects every moderation procedure composes (issue #38).
 *
 * The invariants live here so no procedure can skip them: every effect logs a
 * `moderation_action` row (the audit log is append-only by construction — the
 * only writes to it are `logAction` calls), emails the affected user through
 * the same `sendEmail` pipe as the auth flows, and — for the appealable
 * actions — mints the signed-out appeal link the email points at.
 */

/**
 * The database surface these effects need — the full handle or a transaction.
 *
 * Drizzle's transaction type inherits the query builders from `PgDatabase` but
 * not the driver's `$client`, so it is not assignable to `Database`. Effects
 * that run inside a transaction (removals, suspensions) take this narrower
 * structural type instead, so the same helper serves both a bare `db` and a
 * `tx` with no casts.
 */
export type DbLike = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

/** The nine stable action codes — the `moderation_action.action` check constraint's list. */
export const MODERATION_ACTION_CODES = [
  "post_removed",
  "post_restored",
  "user_suspended",
  "user_unsuspended",
  "user_banned",
  "user_unbanned",
  "role_changed",
  "case_resolved",
  "appeal_resolved",
] as const;

/** One of the nine action codes. */
export type ModerationActionCode = (typeof MODERATION_ACTION_CODES)[number];

/**
 * The four actions an appeal can contest, and the inverse code the overturn
 * logs. `role_changed` maps to itself: the restore is another role change,
 * and its logged row records the full swing (old → the granted role → back).
 */
export const INVERSE_ACTION = {
  post_removed: "post_restored",
  user_suspended: "user_unsuspended",
  user_banned: "user_unbanned",
  role_changed: "role_changed",
} as const;

/**
 * The actions `appealOpen` accepts, derived from the inverse map so the two
 * lists can never drift — anything with an inverse is appealable.
 */
export const APPEALABLE_ACTIONS = Object.keys(INVERSE_ACTION) as ModerationActionCode[];

/**
 * The `moderation_action` row shape the shared effects read.
 *
 * `action` and `targetType` arrive as text from the database; callers cast
 * the select (or the columns via `.$type<>()`) so the effects see the
 * narrowed unions. `details` is the jsonb column read back as `unknown` —
 * each effect casts the shape it knows how to read.
 */
export interface ActionRow {
  id: string;
  action: ModerationActionCode;
  actorId: string | null;
  targetType: "post" | "user";
  targetPostId: string | null;
  targetUserId: string | null;
  details: unknown;
}

export interface LogActionInput {
  /** Which of the nine codes this row records. */
  action: ModerationActionCode;
  /** The moderator who did it. The column is set-null on delete; writes always carry it. */
  actorId: string;
  targetType: "post" | "user";
  /** Exactly one of the two target ids, matching `targetType` — the schema's check constraint enforces it. */
  targetPostId?: string;
  targetUserId?: string;
  /** The moderator's stated reason — mirrored into the affected user's email. */
  reason?: string;
  /** A note only moderators read (the audit log), not emailed. */
  note?: string;
  /** Structured extra: durationSeconds, oldRole/newRole, outcome, counts. Flat scalars, JSON-safe. */
  details?: Record<string, string | number | boolean | null>;
}

/**
 * Appends one row to the audit log and returns its id.
 *
 * Every moderation effect goes through this — there is no path that changes a
 * removal, a ban, a suspension or a role without leaving a row, which is what
 * makes the audit log append-only rather than best-effort. The returned id is
 * what appeal links bind to.
 */
export async function logAction(db: DbLike, input: LogActionInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(moderationAction)
    .values({
      action: input.action,
      actorId: input.actorId,
      targetType: input.targetType,
      targetPostId: input.targetPostId,
      targetUserId: input.targetUserId,
      reason: input.reason,
      note: input.note,
      details: input.details ?? {},
    })
    .returning({ id: moderationAction.id });

  if (!row) throw new Error("moderation_action insert returned no row");
  return row;
}

/**
 * Closes every open report against one target and returns the reporters, so
 * the caller can email each of them. The target's case resolution notice is
 * the reporters' email; the target itself is separately emailed by the
 * procedure that acted (removePost, suspendUser, …).
 */
export async function stampReports(
  db: DbLike,
  args: {
    targetType: "post" | "user";
    targetId: string;
    outcome: "actioned" | "dismissed";
    resolvedBy: string;
    note?: string;
  },
): Promise<{ reporterIds: string[] }> {
  const rows = await db
    .update(report)
    .set({
      resolvedAt: new Date(),
      resolvedBy: args.resolvedBy,
      resolvedOutcome: args.outcome,
      resolutionNote: args.note,
    })
    .where(
      and(
        eq(report.targetType, args.targetType),
        eq(report.targetId, args.targetId),
        sql`${report.resolvedAt} is null`,
      ),
    )
    .returning({ reporterId: report.reporterId });

  return { reporterIds: rows.map((r) => r.reporterId) };
}

/**
 * Sends one moderation email to a user, in their stored language when they
 * have one ("en" or "fr"), otherwise in the request's language — the same
 * `PARAGLIDE_LOCALE` cookie the web app sets.
 */
export async function emailUser(
  db: DbLike,
  headers: Headers | undefined,
  userId: string,
  build: (locale: EmailLocale) => Omit<OutgoingEmail, "to">,
): Promise<void> {
  const [target] = await db
    .select({ email: user.email, localePreference: user.localePreference })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  // The account may be hard-deleted between the action and the send (the
  // FKs cascade); there is nothing to say to it, and the action stands.
  if (!target?.email) return;

  const locale: EmailLocale =
    target.localePreference === "en" || target.localePreference === "fr"
      ? target.localePreference
      : localeFromRequest(headers);

  await sendEmail({ to: target.email, ...build(locale) });
}

/**
 * The signed-out appeal link for an action — what removals, suspensions and
 * bans email, and what `appealOpen` verifies. One-time: the token carries a
 * fresh nonce and the appeal row consumes it.
 */
export function makeAppealUrl(actionId: string, userId: string): string {
  const token = appealToken.sign({
    purpose: "appeal",
    actionId,
    userId,
    nonce: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
  });
  return `${webOrigin}/appeal?token=${token}`;
}

/**
 * Whether a logged action is still in force.
 *
 * The appeal gates (`appealOpen`, `appealReview`) check this so an overturn
 * never tries to reverse something already reversed, and an appeal can't
 * contest a decision that no longer applies. Each check reads the real state
 * rather than a stored flag: a removal while the tombstone stands, a
 * suspension while its clock runs, a ban while the flag is set, a role
 * change while the granted role holds.
 */
export async function isActionCurrent(
  db: DbLike,
  action: Pick<ActionRow, "action" | "targetPostId" | "targetUserId" | "details">,
): Promise<boolean> {
  switch (action.action) {
    case "post_removed": {
      if (!action.targetPostId) return false;
      const [target] = await db
        .select({ removedAt: post.removedAt })
        .from(post)
        .where(eq(post.id, action.targetPostId))
        .limit(1);
      return target?.removedAt != null;
    }
    case "user_suspended":
    case "user_banned": {
      if (!action.targetUserId) return false;
      const [target] = await db
        .select({ banned: user.banned, banExpires: user.banExpires })
        .from(user)
        .where(eq(user.id, action.targetUserId))
        .limit(1);
      if (!target?.banned) return false;
      // A suspension is current only while its clock runs; a ban never expires.
      return action.action === "user_suspended"
        ? target.banExpires != null && target.banExpires.getTime() > Date.now()
        : target.banExpires == null;
    }
    case "role_changed": {
      if (!action.targetUserId) return false;
      const details = action.details as { newRole?: string } | null;
      if (!details?.newRole) return false;
      const [target] = await db
        .select({ role: user.role })
        .from(user)
        .where(eq(user.id, action.targetUserId))
        .limit(1);
      return target?.role === details.newRole;
    }
    default:
      // Not appealable — `appealOpen` filters these out before ever calling.
      return false;
  }
}

/**
 * Restores a removed post, logging and emailing the author — the inverse of a
 * removal, shared by `moderation.restorePost` and the appeal overturn.
 */
export async function restorePostEffect(
  db: DbLike,
  args: { postId: string; actorId: string; note?: string; headers: Headers | undefined },
): Promise<void> {
  // Read the tombstone BEFORE clearing it — a `returning` clause on the update
  // below would report the post-update value (always null) and make the
  // already-restored check below fire on every call.
  const [target] = await db
    .select({ id: post.id, authorId: post.authorId, removedAt: post.removedAt })
    .from(post)
    .where(eq(post.id, args.postId))
    .limit(1);

  if (!target) throw new ORPCError("NOT_FOUND", { message: "This post doesn't exist." });

  // Already restored (a race with the appeal overturn or a manual restore):
  // nothing to log — the first restore's audit row exists, and a second one
  // would lie about what happened.
  if (target.removedAt === null) return;

  await db
    .update(post)
    .set({ removedAt: null, removedBy: null, removedReason: null })
    .where(eq(post.id, args.postId));

  await logAction(db, {
    action: "post_restored",
    actorId: args.actorId,
    targetType: "post",
    targetPostId: args.postId,
    note: args.note,
  });
  await emailUser(db, args.headers, target.authorId, (locale) => moderationRestoreEmail(locale));
}

/**
 * Clears a ban or suspension, logging the precise code from the expiry read
 * before clearing — shared by `moderation.unbanUser` and the appeal overturn.
 */
export async function unbanEffect(
  db: DbLike,
  args: { userId: string; actorId: string; note?: string; headers: Headers | undefined },
): Promise<void> {
  const [target] = await db
    .select({ banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, args.userId))
    .limit(1);

  if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });
  if (!target.banned) {
    throw new ORPCError("BAD_REQUEST", { message: "This account isn't banned or suspended." });
  }

  // A row with an expiry was a suspension; without one, a ban. The code the
  // audit log records and the email the user receives follow the read.
  const code: ModerationActionCode = target.banExpires != null ? "user_unsuspended" : "user_unbanned";

  await db
    .update(user)
    .set({ banned: false, banReason: null, banExpires: null })
    .where(eq(user.id, args.userId));

  await logAction(db, {
    action: code,
    actorId: args.actorId,
    targetType: "user",
    targetUserId: args.userId,
    note: args.note,
  });
  await emailUser(db, args.headers, args.userId, (locale) =>
    code === "user_unsuspended" ? moderationUnsuspensionEmail(locale) : moderationUnbanEmail(locale),
  );
}

/**
 * Reverses an appealable action — the overturn half of `moderation.appealReview`.
 *
 * Race-tolerant on purpose: the currency pre-check (`isActionCurrent`) is
 * advisory. If the action was already undone between the check and here
 * (another reviewer, or a moderator restoring manually), the effect becomes a
 * no-op but the appeal still gets stamped — a legitimate overturn is never
 * reported as failed over a lost race.
 */
export async function undoAction(
  db: DbLike,
  action: ActionRow,
  actorId: string,
  note: string | undefined,
  headers: Headers | undefined,
): Promise<void> {
  if (!APPEALABLE_ACTIONS.includes(action.action)) {
    throw new ORPCError("BAD_REQUEST", { message: "This action can't be overturned." });
  }
  if (!(await isActionCurrent(db, action))) return;

  switch (action.action) {
    case "post_removed": {
      await restorePostEffect(db, { postId: action.targetPostId!, actorId, note, headers });
      break;
    }
    case "user_suspended":
    case "user_banned": {
      await unbanEffect(db, { userId: action.targetUserId!, actorId, note, headers });
      break;
    }
    case "role_changed": {
      const details = action.details as { oldRole?: string } | null;
      const oldRole = details?.oldRole;
      if (!oldRole) {
        throw new ORPCError("BAD_REQUEST", { message: "This action can't be overturned." });
      }
      const [target] = await db
        .select({ role: user.role })
        .from(user)
        .where(eq(user.id, action.targetUserId!))
        .limit(1);
      if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });

      await db.update(user).set({ role: oldRole }).where(eq(user.id, action.targetUserId!));
      await logAction(db, {
        action: "role_changed",
        actorId,
        targetType: "user",
        targetUserId: action.targetUserId!,
        details: { oldRole: target.role ?? "user", newRole: oldRole },
      });
      await emailUser(db, headers, action.targetUserId!, (locale) =>
        moderationRoleEmail({ role: oldRole }, locale),
      );
      break;
    }
  }
}
