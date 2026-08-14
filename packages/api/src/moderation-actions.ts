import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import {
  localeFromRequest,
  moderationBanEmail,
  moderationRemovalEmail,
  moderationRestoreEmail,
  moderationRoleEmail,
  moderationSuspensionEmail,
  moderationUnbanEmail,
  moderationUnsuspensionEmail,
  sendEmail,
  webOrigin,
  type EmailLocale,
  type OutgoingEmail,
} from "@my-tuums/auth";
import type { Database } from "@my-tuums/db";
import { moderationAction, post, report, session, user } from "@my-tuums/db/schema";
import { appealToken } from "./appeal-token.js";
import { canManageRole, type UserRole } from "./roles.js";

/**
 * The shared effects every moderation procedure composes (issue #38) — the
 * forward actions (`removePostEffect`, `suspendUserEffect`, `banUserEffect`,
 * `setRoleEffect`) and their inverses (`restorePostEffect`, `unbanEffect`,
 * `undoAction`).
 *
 * The invariants live here so no procedure can skip them: every effect runs
 * its state change and its `moderation_action` row in ONE transaction (the
 * audit log is append-only by construction — the only writes to it are
 * `logAction` calls), reads its guard `FOR UPDATE` inside that transaction,
 * and returns the email it owes as a `PendingEmail` rather than sending it —
 * the caller sends after its own commit, so a rollback can never produce an
 * email describing an action that never happened. The appealable actions mint
 * the signed-out appeal link the email points at.
 */

/**
 * The database surface these effects need — the full handle or a transaction.
 *
 * Drizzle's transaction type inherits the query builders from `PgDatabase` but
 * not the driver's `$client`, so it is not assignable to `Database`. Effects
 * that run inside a transaction (removals, suspensions) take this narrower
 * structural type instead, so the same helper serves both a bare `db` and a
 * `tx` with no casts.
 *
 * `transaction` is included so an effect can commit its own state change and
 * audit row together (restorePostEffect, unbanEffect) — and nest inside a
 * caller's transaction (savepoints) when one is already open, which is what
 * the appeal overturn does.
 */
export type DbLike = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "execute" | "transaction"
>;

/**
 * The nine stable action codes and the appealable/inverse lists — defined in
 * the dependency-free `./constants.js` (see the comment there for why),
 * re-exported here so every runtime importer keeps one import site.
 */
import {
  APPEALABLE_ACTIONS,
  INVERSE_ACTION,
  MODERATION_ACTION_CODES,
  type ModerationActionCode,
} from "./constants.js";

export { APPEALABLE_ACTIONS, INVERSE_ACTION, MODERATION_ACTION_CODES, type ModerationActionCode };

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
  createdAt: Date;
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
 * One email an effect owes, handed back by the effect and sent by the caller
 * AFTER its transaction commits. Every effect returns these instead of sending:
 * an email sent from inside a transaction that later aborts would describe an
 * action that never happened.
 */
export type PendingEmail = {
  userId: string;
  build: (locale: EmailLocale) => Omit<OutgoingEmail, "to">;
};

/**
 * Sends the emails an effect returned, after the caller's transaction has
 * committed. A failed send is logged and swallowed — the action stands, and
 * the log is for operators (see `emailUser`).
 */
export async function sendPendingEmails(
  db: DbLike,
  headers: Headers | undefined,
  pending: PendingEmail[],
): Promise<void> {
  for (const email of pending) {
    await emailUser(db, headers, email.userId, email.build);
  }
}

/**
 * The notice a restore owes — shared by `restorePostEffect` and the appeal
 * overturn, so the copy decision lives in one place.
 */
export function restoreNotice(userId: string): PendingEmail {
  return { userId, build: (locale) => moderationRestoreEmail(locale) };
}

/**
 * The notice an unban or unsuspension owes — the copy follows the code the
 * effect logged, shared by `unbanEffect` and the appeal overturn.
 */
export function unbanNotice(
  userId: string,
  code: "user_unbanned" | "user_unsuspended",
): PendingEmail {
  return {
    userId,
    build: (locale) =>
      code === "user_unsuspended"
        ? moderationUnsuspensionEmail(locale)
        : moderationUnbanEmail(locale),
  };
}

/**
 * The notice a role change owes — the role is optional (a setRole without one).
 */
export function roleNotice(args: { userId: string; role: string; reason?: string }): PendingEmail {
  return {
    userId: args.userId,
    build: (locale) => moderationRoleEmail({ role: args.role, reason: args.reason }, locale),
  };
}

/**
 * Sends one moderation email to a user, in their stored language when they
 * have one ("en" or "fr"), otherwise in the request's language — the same
 * `PARAGLIDE_LOCALE` cookie the web app sets.
 *
 * A failed send is logged and swallowed: every caller mails *after* the
 * action's transaction has committed, so surfacing the error would turn a
 * done deal into a failed moderation call — the moderator retries, and gets
 * the "already removed" class of errors while the notice never goes out.
 * The action stands; the log is for operators.
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

  try {
    await sendEmail({ to: target.email, ...build(locale) });
  } catch (error) {
    console.error("Moderation email failed to send", { to: target.email, userId }, error);
  }
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
 * Removes a post — the forward half of `moderation.removePost`.
 *
 * The tombstone, the report stamps and the `post_removed` audit row commit
 * in ONE transaction: a failure between any of them would otherwise leave
 * the post removed with no trail of who removed it, or the reports stamped
 * with no removal. The guard read (does the post exist, is it still up?)
 * happens inside that transaction under a row lock, so two concurrent
 * removals serialize instead of both passing the check and each logging.
 *
 * The author's notice is returned, not sent — the caller sends it after the
 * transaction commits, so a failed send cannot roll the removal back and a
 * rollback can never produce an email.
 */
export async function removePostEffect(
  db: DbLike,
  args: { postId: string; actorId: string; reason: string },
): Promise<{ pending: PendingEmail }> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: post.id,
        content: post.content,
        authorId: post.authorId,
        removedAt: post.removedAt,
      })
      .from(post)
      .where(eq(post.id, args.postId))
      .for("update")
      .limit(1);
    if (!target) throw new ORPCError("NOT_FOUND", { message: "This post doesn't exist." });
    if (target.removedAt) {
      throw new ORPCError("BAD_REQUEST", { message: "This post is already removed." });
    }

    await tx
      .update(post)
      .set({ removedAt: new Date(), removedBy: args.actorId, removedReason: args.reason })
      .where(eq(post.id, args.postId));
    await stampReports(tx, {
      targetType: "post",
      targetId: args.postId,
      outcome: "actioned",
      resolvedBy: args.actorId,
      note: args.reason,
    });
    const action = await logAction(tx, {
      action: "post_removed",
      actorId: args.actorId,
      targetType: "post",
      targetPostId: args.postId,
      reason: args.reason,
    });
    return {
      pending: {
        userId: target.authorId,
        build: (locale) =>
          moderationRemovalEmail(
            {
              postText: target.content,
              reason: args.reason,
              appealUrl: makeAppealUrl(action.id, target.authorId),
            },
            locale,
          ),
      },
    };
  });
}

/**
 * Suspends a user for a bounded time — the forward half of
 * `moderation.suspendUser`.
 *
 * The ban-with-expiry, the session sweep, the report stamps and the
 * `user_suspended` audit row commit in ONE transaction: a failure between
 * any of them would otherwise leave the account locked with no trail, or the
 * sessions dead with the account still free. The guard read (does the
 * account exist, is the actor allowed to manage it, is it not permanently
 * banned?) happens inside that transaction under a row lock.
 *
 * PostgreSQL owns the expiry: the returned `banExpires` is the stored value
 * from the update, and the caller uses that exact timestamp in both the
 * response and the notice — never a second application-clock value.
 *
 * The notice is returned, not sent — the caller sends it after the
 * transaction commits.
 */
export async function suspendUserEffect(
  db: DbLike,
  args: {
    userId: string;
    actorId: string;
    actorRole: string;
    reason: string;
    durationSeconds: number;
  },
): Promise<{ banExpires: Date; pending: PendingEmail }> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: user.id,
        role: user.role,
        banned: user.banned,
        banExpires: user.banExpires,
      })
      .from(user)
      .where(eq(user.id, args.userId))
      .for("update")
      .limit(1);
    if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });
    // Rank guard: a moderator cannot suspend a moderator; nobody can
    // suspend themselves (an actor always holds their own rank).
    if (!canManageRole(args.actorRole, target.role ?? "user")) {
      throw new ORPCError("FORBIDDEN");
    }
    // A suspension replaces the expiry, so it must never land on a
    // permanent ban — one click would turn a staff sentence into a
    // lapsing one. Lifting the ban first is the explicit path.
    if (target.banned && !target.banExpires) {
      throw new ORPCError("BAD_REQUEST", {
        message: "This account is permanently banned. Unban it before suspending.",
      });
    }

    const [updated] = await tx
      .update(user)
      .set({
        banned: true,
        banReason: args.reason,
        banExpires: sql`now() + ${args.durationSeconds} * interval '1 second'`,
      })
      .where(eq(user.id, args.userId))
      .returning({ banExpires: user.banExpires });
    // PostgreSQL is the authority for `now()`. Returning the stored value
    // keeps the response and the notification aligned with the timestamp
    // that actually controls visibility and sign-in expiry, even when the
    // application and database clocks differ.
    if (!updated?.banExpires) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Failed to set the suspension expiry.",
      });
    }
    const banExpires: Date = updated.banExpires;
    // Every session dies with the suspension — the account is locked
    // until the clock runs out or a moderator lifts it.
    await tx.delete(session).where(eq(session.userId, args.userId));
    await stampReports(tx, {
      targetType: "user",
      targetId: args.userId,
      outcome: "actioned",
      resolvedBy: args.actorId,
      note: args.reason,
    });
    const action = await logAction(tx, {
      action: "user_suspended",
      actorId: args.actorId,
      targetType: "user",
      targetUserId: args.userId,
      reason: args.reason,
      details: { durationSeconds: args.durationSeconds },
    });
    return {
      banExpires,
      pending: {
        userId: args.userId,
        build: (locale) =>
          moderationSuspensionEmail(
            {
              reason: args.reason,
              expiresAt: banExpires,
              appealUrl: makeAppealUrl(action.id, args.userId),
            },
            locale,
          ),
      },
    };
  });
}

/**
 * Bans a user permanently — a suspension without an expiry, the forward half
 * of `moderation.banUser`. Same shape as `suspendUserEffect`, staff+ gate.
 */
export async function banUserEffect(
  db: DbLike,
  args: { userId: string; actorId: string; actorRole: string; reason: string },
): Promise<{ pending: PendingEmail }> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: user.id, role: user.role })
      .from(user)
      .where(eq(user.id, args.userId))
      .for("update")
      .limit(1);
    if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });
    if (!canManageRole(args.actorRole, target.role ?? "user")) {
      throw new ORPCError("FORBIDDEN");
    }

    await tx
      .update(user)
      .set({ banned: true, banReason: args.reason, banExpires: null })
      .where(eq(user.id, args.userId));
    await tx.delete(session).where(eq(session.userId, args.userId));
    await stampReports(tx, {
      targetType: "user",
      targetId: args.userId,
      outcome: "actioned",
      resolvedBy: args.actorId,
      note: args.reason,
    });
    const action = await logAction(tx, {
      action: "user_banned",
      actorId: args.actorId,
      targetType: "user",
      targetUserId: args.userId,
      reason: args.reason,
    });
    return {
      pending: {
        userId: args.userId,
        build: (locale) =>
          moderationBanEmail(
            {
              reason: args.reason,
              appealUrl: makeAppealUrl(action.id, args.userId),
            },
            locale,
          ),
      },
    };
  });
}

/**
 * Changes a user's role — the forward half of `moderation.setRole`.
 *
 * The role write and the `role_changed` audit row commit in ONE transaction.
 * The guard read (does the account exist, is the actor allowed to manage it,
 * is the role actually different?) happens inside that transaction under a
 * row lock.
 *
 * The staff-gate check that oRPC cannot express at build time — granting
 * staff or admin requires the actor to be admin — stays at the procedure
 * seam: it is a gate on the caller, not a fact about the target, and the
 * procedure already carries the staff gate.
 */
export async function setRoleEffect(
  db: DbLike,
  args: { userId: string; actorId: string; actorRole: string; role: UserRole },
): Promise<{ pending: PendingEmail }> {
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: user.id, role: user.role })
      .from(user)
      .where(eq(user.id, args.userId))
      .for("update")
      .limit(1);
    if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });
    if (!canManageRole(args.actorRole, target.role ?? "user")) {
      throw new ORPCError("FORBIDDEN");
    }
    if (target.role === args.role) {
      throw new ORPCError("BAD_REQUEST", { message: `This account already has that role.` });
    }

    await tx.update(user).set({ role: args.role }).where(eq(user.id, args.userId));
    await logAction(tx, {
      action: "role_changed",
      actorId: args.actorId,
      targetType: "user",
      targetUserId: args.userId,
      details: { oldRole: target.role ?? "user", newRole: args.role },
    });
  });
  return {
    pending: {
      userId: args.userId,
      build: (locale) => moderationRoleEmail({ role: args.role }, locale),
    },
  };
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
 * Whether a logged action is the latest of its kind against its target.
 *
 * `isActionCurrent` judges an action against the target's *live state*; this
 * judges it against the action *log*. The two answer different questions:
 * remove → appeal → restore → remove again leaves the first removal's state
 * check reading the *second* tombstone as "still current", when the appeal
 * actually contests a decision that no longer governs anything. Overturning
 * a superseded action would reverse the newer one's state, so appeals gate
 * on both: current (there is something to contest) AND latest (what's there
 * is the contested thing).
 */
export async function isActionLatest(
  db: DbLike,
  action: Pick<
    ActionRow,
    "id" | "action" | "targetType" | "targetPostId" | "targetUserId" | "createdAt"
  >,
): Promise<boolean> {
  const targetMatch =
    action.targetType === "post"
      ? eq(moderationAction.targetPostId, action.targetPostId!)
      : eq(moderationAction.targetUserId, action.targetUserId!);

  const [newer] = await db
    .select({ id: moderationAction.id })
    .from(moderationAction)
    .where(
      and(
        // Redundant — the `moderation_action_target_match` check constraint
        // guarantees target_type agrees with whichever target column is set —
        // but it is what lets the planner use `moderation_action_target_idx`,
        // whose leading column is target_type. Without it this lookup seq-scans
        // the whole audit log (issue #55).
        eq(moderationAction.targetType, action.targetType),
        eq(moderationAction.action, action.action),
        targetMatch,
        // Row-value comparison under the same (created_at, id) ordering the
        // `moderation_action_created_idx` index provides. `sql.param` keeps
        // the driver's type mapping — a bare interpolated Date would reach
        // postgres.js untyped.
        sql`(${moderationAction.createdAt}, ${moderationAction.id}) > (${sql.param(action.createdAt, moderationAction.createdAt)}, ${sql.param(action.id, moderationAction.id)})`,
      ),
    )
    .limit(1);

  return newer === undefined;
}

/**
 * Restores a removed post — the inverse of a removal, shared by
 * `moderation.restorePost` and the appeal overturn.
 *
 * The tombstone clear and its audit row commit in ONE transaction: a restore
 * that fails midway must not leave the post visible with no `post_restored`
 * row, or leave a row describing a restore that never happened. The guard
 * read (is the tombstone still set?) happens inside that same transaction
 * under a row lock, so two concurrent restores serialize instead of both
 * passing the check and each logging (issue #51). The author's email is
 * deliberately NOT sent here — the caller sends it after its own transaction
 * commits. The appeal overturn runs inside the review transaction
 * (moderation.appealReview), and an email sent from inside a transaction that
 * later aborts would describe an action that never happened.
 *
 * Returns the author's notice, or an empty array when there was nothing to
 * restore (a race with the appeal overturn or a manual restore already
 * cleared the tombstone) — the first restore's audit row exists, and a
 * second one would lie about what happened. Callers send the returned
 * notices only after their own transaction commits.
 */
export async function restorePostEffect(
  db: DbLike,
  args: { postId: string; actorId: string; note?: string },
): Promise<PendingEmail[]> {
  // The guard read lives INSIDE the transaction, under the same row lock the
  // forward paths take — a moderator's Restore racing the appeal overturn
  // must not both pass an unlocked "is it still removed?" check and each log
  // a `post_restored` row that lies about what happened (issue #51). The lock
  // serializes them: the loser's read observes the winner's commit and
  // returns an empty array below. The read also has to happen BEFORE the
  // clear — a `returning` clause on the update would report the post-update
  // value (always null) and make the already-restored check fire on every
  // call.
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: post.id, authorId: post.authorId, removedAt: post.removedAt })
      .from(post)
      .where(eq(post.id, args.postId))
      .for("update")
      .limit(1);

    if (!target) throw new ORPCError("NOT_FOUND", { message: "This post doesn't exist." });

    // Already restored (a race with the appeal overturn or a manual restore):
    // nothing to log — the first restore's audit row exists, and a second one
    // would lie about what happened.
    if (target.removedAt === null) return [];

    await tx
      .update(post)
      .set({ removedAt: null, removedBy: null, removedReason: null })
      .where(eq(post.id, args.postId));

    await logAction(tx, {
      action: "post_restored",
      actorId: args.actorId,
      targetType: "post",
      targetPostId: args.postId,
      note: args.note,
    });

    return [restoreNotice(target.authorId)];
  });
}

/**
 * Clears a ban or suspension, logging the precise code from the expiry read
 * before clearing — shared by `moderation.unbanUser` and the appeal overturn.
 *
 * The clear and its audit row commit in ONE transaction, and the email is
 * sent by the caller after commit — the same shape as `restorePostEffect`,
 * including the guard read (is the sentence still in force?) inside the
 * transaction under a row lock, so two concurrent unbans serialize instead
 * of both passing the check and each logging and emailing (issue #51).
 *
 * Carries the same rank guard as the sentence itself: whoever lifts a ban or
 * suspension must be able to manage the account they're lifting it for — a
 * staff member cannot undo an admin's sentence on a staff peer, any more
 * than they could have imposed it.
 *
 * Returns the notice matching the logged code (`user_unbanned` for a ban,
 * `user_unsuspended` for a suspension), or an empty array when nothing was
 * done — either the account was never banned (only reachable with
 * `tolerateNotBanned`) or a racing manual unban won the window between
 * the appeal's `isActionCurrent` pre-check and this read.
 */
export async function unbanEffect(
  db: DbLike,
  args: {
    userId: string;
    actorId: string;
    /** The actor's own role — the guard compares it against the target's. */
    actorRole: string;
    note?: string;
    /**
     * When true, an account that is no longer banned is a no-op instead of a
     * BAD_REQUEST — the appeal path, where a lost race with a manual unban
     * must not fail the overturn. The direct `moderation.unbanUser` keeps
     * the strict check: its caller-facing error is the readable answer to
     * "why didn't my unban work?"
     */
    tolerateNotBanned?: boolean;
  },
): Promise<PendingEmail[]> {
  // Same shape as restorePostEffect (issue #51): the guard read happens
  // inside the transaction under a row lock, so two concurrent unbans cannot
  // both read "banned" and each write a `user_unbanned` row and email the
  // user. The lock serializes them — the loser observes the winner's commit
  // and either no-ops (the appeal path's tolerateNotBanned) or refuses with
  // the caller-facing error (the direct path's strict check).
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ banned: user.banned, banExpires: user.banExpires, role: user.role })
      .from(user)
      .where(eq(user.id, args.userId))
      .for("update")
      .limit(1);

    if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });
    if (!target.banned) {
      if (args.tolerateNotBanned) return [];
      throw new ORPCError("BAD_REQUEST", { message: "This account isn't banned or suspended." });
    }
    if (!canManageRole(args.actorRole, target.role ?? "user")) {
      throw new ORPCError("FORBIDDEN");
    }

    // A row without an expiry was a ban; with one, a suspension. The code the
    // audit log records and the email the user receives follow the read.
    const code: "user_unbanned" | "user_unsuspended" =
      target.banExpires == null ? "user_unbanned" : "user_unsuspended";

    await tx
      .update(user)
      .set({ banned: false, banReason: null, banExpires: null })
      .where(eq(user.id, args.userId));

    await logAction(tx, {
      action: code,
      actorId: args.actorId,
      targetType: "user",
      targetUserId: args.userId,
      note: args.note,
    });

    return [unbanNotice(args.userId, code)];
  });
}

/**
 * Reverses an appealable action — the overturn half of `moderation.appealReview`.
 *
 * Race-tolerant on purpose, and that tolerance is now real rather than
 * aspirational: the currency pre-check (`isActionCurrent`) is advisory, and
 * if the action was already undone between the check and here (another
 * reviewer, or a moderator acting manually), the effect becomes a no-op —
 * `restorePostEffect` returns an empty array on an already-restored post,
 * `unbanEffect` with `tolerateNotBanned` returns an empty array on an
 * already-cleared sentence — so the appeal still gets stamped and a
 * legitimate overturn is never reported as failed over a lost race.
 *
 * The rank guard is NOT advisory: an overturn restores a state the reviewer
 * must be able to manage themselves — the same `canManageRole` rule as the
 * sentence that created it, applied to both the role currently held and the
 * role being restored (for `role_changed`), or to the target's role (for
 * bans). A moderator overturning a demotion appeal cannot re-grant staff;
 * only someone who could have imposed the state can undo it.
 *
 * Runs inside the caller's transaction (it is only ever called from the
 * appeal review's), so the state change and its audit row are not committed
 * until the review commits. The emails the reversal owes are returned, not
 * sent.
 */
export async function undoAction(
  db: DbLike,
  action: ActionRow,
  actorId: string,
  actorRole: string,
  note: string | undefined,
): Promise<PendingEmail[]> {
  if (!APPEALABLE_ACTIONS.includes(action.action)) {
    throw new ORPCError("BAD_REQUEST", { message: "This action can't be overturned." });
  }
  if (!(await isActionCurrent(db, action))) return [];

  const pending: PendingEmail[] = [];

  switch (action.action) {
    case "post_removed": {
      pending.push(
        ...(await restorePostEffect(db, {
          postId: action.targetPostId!,
          actorId,
          note,
        })),
      );
      break;
    }
    case "user_suspended":
    case "user_banned": {
      pending.push(
        ...(await unbanEffect(db, {
          userId: action.targetUserId!,
          actorId,
          actorRole,
          note,
          tolerateNotBanned: true,
        })),
      );
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

      // Both ends of the swing must be manageable: the role currently held
      // (what the reviewer would be acting on) and the role being restored.
      if (!canManageRole(actorRole, target.role ?? "user") || !canManageRole(actorRole, oldRole)) {
        throw new ORPCError("FORBIDDEN");
      }

      await db.update(user).set({ role: oldRole }).where(eq(user.id, action.targetUserId!));
      await logAction(db, {
        action: "role_changed",
        actorId,
        targetType: "user",
        targetUserId: action.targetUserId!,
        details: { oldRole: target.role ?? "user", newRole: oldRole },
      });
      pending.push(roleNotice({ userId: action.targetUserId!, role: oldRole }));
      break;
    }
  }

  return pending;
}
