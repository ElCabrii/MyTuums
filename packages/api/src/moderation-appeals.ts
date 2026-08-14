import { and, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { moderationResolutionEmail } from "@my-tuums/auth";
import { appeal, moderationAction } from "@my-tuums/db/schema";
import { APPEAL_TOKEN_MAX_LENGTH } from "./appeal-token.js";
import { openAppealFromRemovedPost, openAppealFromToken } from "./appeal-intake.js";
import { APPEAL_REASON_MAX_LENGTH, APPEAL_REASON_MIN_LENGTH } from "./constants.js";
import {
  emailUser,
  isActionLatest,
  logAction,
  sendPendingEmails,
  undoAction,
  type ActionRow,
  type PendingEmail,
} from "./moderation-actions.js";
import { noteInput } from "./moderation-inputs.js";
import { baseProcedure, moderatorProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

/**
 * The two appeal procedures: `appealOpen` — the app's ONE public surface (a
 * suspended user cannot sign in; the HMAC token is the gate) — and
 * `appealReview`, the moderator's uphold-or-overturn decision.
 *
 * `appealOpen` is deliberately thin: it validates the transport shape
 * (exactly one of `token`/`postId`, a session for the postId path) and then
 * delegates the whole intake — the source adapters, the validity, replay and
 * persistence rules — to the deep module in `./appeal-intake.ts`. The
 * procedure owns no business rule of its own, so it cannot drift from them.
 *
 * `appealOpen` is not unthrottled for being public: the intake consumes its
 * own budget on the `report` tier, keyed on the capability the caller
 * presented rather than on a session (see `rateLimitCapability` in
 * procedures.ts and the intake module).
 */

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

      if (input.token) {
        return openAppealFromToken(context, input.token, input.reason);
      }

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
      return openAppealFromRemovedPost(context, sessionUser, postId, input.reason);
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
