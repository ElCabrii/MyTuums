import { randomUUID } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { moderationResolutionEmail } from "@my-tuums/auth";
import type { Database } from "@my-tuums/db";
import { appeal, moderationAction, post } from "@my-tuums/db/schema";
import { APPEAL_TOKEN_MAX_LENGTH, appealToken } from "./appeal-token.js";
import {
  APPEALABLE_ACTIONS,
  APPEAL_REASON_MAX_LENGTH,
  APPEAL_REASON_MIN_LENGTH,
} from "./constants.js";
import {
  emailUser,
  isActionCurrent,
  isActionLatest,
  logAction,
  sendPendingEmails,
  undoAction,
  type ActionRow,
  type PendingEmail,
} from "./moderation-actions.js";
import { noteInput } from "./moderation-inputs.js";
import { baseProcedure, moderatorProcedure, rateLimit, rateLimitCapability } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

/**
 * The two appeal procedures: `appealOpen` — the app's ONE public surface (a
 * suspended user cannot sign in; the HMAC token is the gate) — and
 * `appealReview`, the moderator's uphold-or-overturn decision.
 *
 * `appealOpen` is not unthrottled for being public: it consumes its own
 * budget on the `report` tier, keyed on the capability the caller presented
 * rather than on a session (see `rateLimitCapability` in procedures.ts).
 */

/** The user an action happened to — its target user, or the author for post actions. */
async function actionTargetUser(db: Database, action: ActionRow): Promise<string | null> {
  if (action.targetType === "user") return action.targetUserId;
  if (!action.targetPostId) return null;
  const [target] = await db
    .select({ authorId: post.authorId })
    .from(post)
    .where(eq(post.id, action.targetPostId))
    .limit(1);
  return target?.authorId ?? null;
}

/** postgres.js surfaces constraint violations as errors carrying a code; 23505 is unique_violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

export const appealsRouter = {
  /**
   * Opens an appeal — the app's ONE public surface (see `baseProcedure`).
   *
   * Either `token` (the signed-out HMAC link from the email) or `postId` (a
   * signed-in author appealing their own removed post) identifies the
   * action, exactly one of the two. Both branches consume the `report`
   * rate tier (20/min), keyed on the capability the caller presented — the
   * link's nonce, or the appealed action's id — never on a session, which
   * the token branch cannot have by construction. The signature check
   * itself stays unthrottled: a bad signature is rejected by a cheap HMAC
   * comparison before any database work, and only the link's holder can
   * present a signature that consumes budget.
   */
  appealOpen: baseProcedure
    .input(
      z.object({
        token: z.string().min(1).max(APPEAL_TOKEN_MAX_LENGTH).optional(),
        postId: z.uuid().optional(),
        reason: z.string().trim().min(APPEAL_REASON_MIN_LENGTH).max(APPEAL_REASON_MAX_LENGTH),
      }),
    )
    .handler(async ({ input, context }) => {
      if ((input.token ? 1 : 0) + (input.postId ? 1 : 0) !== 1) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Provide either an appeal link or the removed post.",
        });
      }

      let actionId: string;
      let userId: string;
      let nonce: string;

      if (input.token) {
        const payload = appealToken.verify(input.token);
        if (!payload) {
          throw new ORPCError("BAD_REQUEST", {
            message: "This appeal link is invalid or has expired.",
          });
        }
        // One budget per link, keyed on its nonce — the capability the
        // caller presented, and unguessable to anyone who does not hold
        // the email. An invalid signature is rejected above before any
        // database work, so this consume is only ever reached by someone
        // holding a genuine link.
        rateLimitCapability(context, RATE_LIMITS.report, `appeal:${payload.nonce}`);
        actionId = payload.actionId;
        userId = payload.userId;
        nonce = payload.nonce;
      } else {
        // The signed-in path runs on the base procedure, so the session is
        // read directly rather than through `context.user` (which only
        // `protectedProcedure` adds).
        const sessionUser = context.session?.user;
        if (!sessionUser) throw new ORPCError("UNAUTHORIZED");
        const postId = input.postId; // guaranteed by the XOR check above
        if (!postId) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Provide either an appeal link or the removed post.",
          });
        }
        // The signed-in path: the author appealing their own removed post.
        // The latest removal record is what an appeal contests.
        const [removal] = await context.db
          .select({ id: moderationAction.id })
          .from(moderationAction)
          .where(
            and(
              // Redundant — the `moderation_action_target_match` check
              // constraint guarantees a post target has target_type = 'post' —
              // but it is what lets the planner use `moderation_action_target_idx`,
              // whose leading column is target_type (issue #55).
              eq(moderationAction.targetType, "post"),
              eq(moderationAction.action, "post_removed"),
              eq(moderationAction.targetPostId, postId),
            ),
          )
          .orderBy(desc(moderationAction.createdAt), desc(moderationAction.id))
          .limit(1);
        if (!removal) {
          throw new ORPCError("NOT_FOUND", { message: "This post has no removal to appeal." });
        }
        // The budget lands here, after the one query that finds the action
        // (its id is the key, unknowable before this) and before the five
        // that follow: the post and ownership checks plus the common tail.
        // A flood of postIds that never resolve to a removal pays one
        // lookup each and stops at NOT_FOUND; a stranger probing a
        // known-removed post can spend this action's 20/min, but the
        // email-token branch keys on its own nonce, so a legitimate
        // appellant is at worst delayed a minute on the signed-in path.
        rateLimitCapability(context, RATE_LIMITS.report, `appeal:${removal.id}`);
        const [target] = await context.db
          .select({ authorId: post.authorId })
          .from(post)
          .where(eq(post.id, postId))
          .limit(1);
        if (!target) throw new ORPCError("NOT_FOUND", { message: "This post doesn't exist." });
        if (target.authorId !== sessionUser.id) {
          throw new ORPCError("FORBIDDEN", { message: "You can only appeal your own posts." });
        }
        actionId = removal.id;
        userId = sessionUser.id;
        nonce = randomUUID();
      }

      // The action must exist, be appealable, belong to the token's user,
      // and still be in force.
      const [actionRow] = await context.db
        .select({
          id: moderationAction.id,
          action: moderationAction.action,
          targetType: moderationAction.targetType,
          targetPostId: moderationAction.targetPostId,
          targetUserId: moderationAction.targetUserId,
          createdAt: moderationAction.createdAt,
          details: moderationAction.details,
        })
        .from(moderationAction)
        .where(eq(moderationAction.id, actionId))
        .limit(1);
      if (!actionRow) {
        throw new ORPCError("BAD_REQUEST", { message: "This appeal link is no longer valid." });
      }
      const action = actionRow as ActionRow;
      if (!APPEALABLE_ACTIONS.includes(action.action)) {
        throw new ORPCError("BAD_REQUEST", { message: "This action can't be appealed." });
      }
      const targetUserId = await actionTargetUser(context.db, action);
      if (!targetUserId || targetUserId !== userId) {
        throw new ORPCError("BAD_REQUEST", { message: "This appeal link is no longer valid." });
      }
      if (!(await isActionCurrent(context.db, action))) {
        throw new ORPCError("BAD_REQUEST", {
          message: "There's nothing to appeal anymore — this action was already undone.",
        });
      }
      if (!(await isActionLatest(context.db, action))) {
        throw new ORPCError("BAD_REQUEST", {
          message: "A newer moderation action has superseded this one.",
        });
      }

      // One query covers both refusals: a REUSED link (same nonce — a double
      // click on the email) and a SECOND appeal against the same action (a
      // fresh link while one is in flight). They answer different questions,
      // so the nonce match wins: "your appeal was received, nothing to do"
      // is the true reading of a replayed link, and a fresh-link retry gets
      // the open-appeal message instead. A *reviewed* appeal is final — the
      // action can never be appealed again (the schema comment and the
      // resolution email both promise that), so a prior row in any status
      // closes this path too.
      const [existing] = await context.db
        .select({ id: appeal.id, status: appeal.status, tokenNonce: appeal.tokenNonce })
        .from(appeal)
        .where(or(eq(appeal.actionId, actionId), eq(appeal.tokenNonce, nonce)))
        .limit(1);
      if (existing) {
        if (existing.tokenNonce === nonce) {
          throw new ORPCError("BAD_REQUEST", {
            message: "This appeal link has already been used.",
          });
        }
        if (existing.status === "open") {
          throw new ORPCError("BAD_REQUEST", {
            message: "There's already an open appeal for this action.",
          });
        }
        throw new ORPCError("BAD_REQUEST", {
          message: "This action has already been appealed, and the review is final.",
        });
      }

      let inserted: { id: string } | undefined;
      try {
        [inserted] = await context.db
          .insert(appeal)
          .values({ actionId, appellantId: userId, tokenNonce: nonce, reason: input.reason })
          .returning({ id: appeal.id });
      } catch (error) {
        // The unique tokenNonce (or the partial unique open-per-action index)
        // caught a replay of a used link, or a racing duplicate open.
        if (isUniqueViolation(error)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "This appeal link has already been used.",
          });
        }
        throw error;
      }
      // Outside the catch on purpose: this is a "cannot happen" guard on the
      // insert's own result, not a database error the unique-violation branch
      // above should ever be asked to classify.
      if (!inserted) throw new Error("appeal insert returned no row");
      return { appealId: inserted.id, status: "open" as const };
    }),

  /**
   * Reviews an open appeal: upholds (decision stands) or overturns (the
   * action is reversed — post restored, ban cleared, role returned), each
   * logging and emailing. The actor of the original action may not review
   * their own work.
   */
  appealReview: moderatorProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(
      z.object({
        appealId: z.uuid(),
        outcome: z.enum(["upheld", "overturned"]),
        note: noteInput,
      }),
    )
    .handler(async ({ input, context }) => {
      const [row] = await context.db
        .select({
          id: appeal.id,
          status: appeal.status,
          appellantId: appeal.appellantId,
          reason: appeal.reason,
          createdAt: appeal.createdAt,
          action: {
            id: moderationAction.id,
            action: moderationAction.action,
            actorId: moderationAction.actorId,
            targetType: moderationAction.targetType,
            targetPostId: moderationAction.targetPostId,
            targetUserId: moderationAction.targetUserId,
            createdAt: moderationAction.createdAt,
            details: moderationAction.details,
          },
        })
        .from(appeal)
        .innerJoin(moderationAction, eq(moderationAction.id, appeal.actionId))
        .where(eq(appeal.id, input.appealId))
        .limit(1);
      if (!row) throw new ORPCError("NOT_FOUND", { message: "This appeal doesn't exist." });
      if (row.status !== "open") {
        throw new ORPCError("BAD_REQUEST", { message: "This appeal has already been reviewed." });
      }
      const action = row.action as ActionRow;
      if (action.actorId === context.user.id) {
        throw new ORPCError("FORBIDDEN", { message: "You can't review your own action." });
      }

      // The overturn, the appeal stamp and the `appeal_resolved` audit row
      // commit in ONE transaction — a failure between any of them would
      // otherwise leave the action reversed with the appeal still open, or
      // the appeal stamped with no audit trail. Emails go out after the
      // commit, the same rule as every other moderation action.
      let pendingEmails: PendingEmail[] = [];
      await context.db.transaction(async (tx) => {
        // Serialize on the appeal row: two reviewers who both passed the
        // "still open" check above would otherwise stamp the same appeal
        // twice — the second transaction must observe the first's commit and
        // refuse instead of overwriting the review.
        const [openAppeal] = await tx
          .select({ id: appeal.id })
          .from(appeal)
          .where(and(eq(appeal.id, input.appealId), eq(appeal.status, "open")))
          .for("update")
          .limit(1);
        if (!openAppeal) {
          throw new ORPCError("BAD_REQUEST", { message: "This appeal has already been reviewed." });
        }

        if (input.outcome === "overturned") {
          // The appeal contests a specific logged action. If a newer action of
          // the same kind has since replaced it (remove → restore → remove,
          // ban → unban → re-ban), overturning would reverse the NEWER state,
          // not the contested one — the same hazard `isActionCurrent`'s
          // live-state read cannot see.
          if (!(await isActionLatest(tx, action))) {
            throw new ORPCError("BAD_REQUEST", {
              message: "A newer moderation action has superseded this one.",
            });
          }
          pendingEmails = await undoAction(
            tx,
            action,
            context.user.id,
            context.user.role ?? "user",
            input.note,
          );
        }

        await tx
          .update(appeal)
          .set({
            status: input.outcome,
            reviewedBy: context.user.id,
            reviewNote: input.note,
            reviewedAt: new Date(),
          })
          .where(eq(appeal.id, input.appealId));

        await logAction(tx, {
          action: "appeal_resolved",
          actorId: context.user.id,
          targetType: action.targetType,
          targetPostId: action.targetPostId ?? undefined,
          targetUserId: action.targetUserId ?? undefined,
          note: input.note,
          details: { outcome: input.outcome },
        });
      });

      // Mail after the transaction commits — the review is final either way.
      await sendPendingEmails(context.db, context.headers, pendingEmails);
      await emailUser(context.db, context.headers, row.appellantId, (locale) =>
        moderationResolutionEmail({ outcome: input.outcome, note: input.note }, locale),
      );
      return { appealId: input.appealId, status: input.outcome };
    }),
};
