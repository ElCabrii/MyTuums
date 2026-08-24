import { and, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { moderationResolutionEmail } from "@my-tuums/auth";
import { appeal, moderationAction } from "@my-tuums/db/schema";
import { openAppeal } from "./appeal-intake.js";
import { APPEAL_TOKEN_MAX_LENGTH } from "./appeal-token.js";
import { APPEAL_REASON_MAX_LENGTH, APPEAL_REASON_MIN_LENGTH } from "./constants.js";
import {
  applyModerationEffect,
  isActionLatest,
  logAction,
  sendModerationEmail,
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
 * Intake and review are deliberately different shapes. `appealOpen` is a thin
 * transport seam over `./appeal-intake.ts`, which owns the whole intake
 * lifecycle: the two capability sources, the budget each spends, the validity
 * gates, the replay policy and the insert race. `appealReview` keeps its logic
 * here because it is a moderator decision composed from the shared effects in
 * `./moderation-actions.ts`, not an intake rule.
 */

export const appealsRouter = {
  /**
   * Opens an appeal — the app's ONE public surface (see `baseProcedure`).
   *
   * This procedure owns the transport contract and nothing else: the input
   * shape, the token's 4 KiB ceiling (repeated by the verifier, which is also
   * exported as a direct function) and the appeal reason's length bounds. Which
   * capability identifies the action, what it costs, whether it may still be
   * appealed and what a replay answers all live in `./appeal-intake.ts` —
   * including the rate budget, which is keyed on the capability the caller
   * presented rather than on a session the token path cannot have.
   */
  appealOpen: baseProcedure
    .input(
      z.object({
        token: z.string().min(1).max(APPEAL_TOKEN_MAX_LENGTH).optional(),
        postId: z.uuid().optional(),
        reason: z.string().trim().min(APPEAL_REASON_MIN_LENGTH).max(APPEAL_REASON_MAX_LENGTH),
      }),
    )
    .handler(({ input, context }) => openAppeal(context, input)),

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
        throw new ORPCError("BAD_REQUEST", { message: "This appeal has already been resolved." });
      }
      // SAFETY: The query selects every ActionRow field, and the schema's action
      // check constraint restricts the stored code to ModerationActionCode.
      const action = row.action as ActionRow;
      if (action.actorId === context.user.id) {
        throw new ORPCError("FORBIDDEN", { message: "You can't review your own action." });
      }

      // The overturn, the appeal stamp and the `appeal_resolved` audit row
      // commit in ONE transaction — a failure between any of them would
      // otherwise leave the action reversed with the appeal still open, or
      // the appeal stamped with no audit trail. The reversal's emails go out
      // after THAT transaction commits, the same rule as every other
      // moderation action: `applyModerationEffect` opens the transaction and
      // sends the notices its effect body returned only after the commit, so
      // an inner savepoint rolled back can never email an action that never
      // happened.
      await applyModerationEffect(context, async (db) => {
        let pending: PendingEmail[] = [];
        // Serialize on the appeal row: two reviewers who both passed the
        // "still open" check above would otherwise stamp the same appeal
        // twice — the second transaction must observe the first's commit and
        // refuse instead of overwriting the review.
        const [openAppeal] = await db
          .select({ id: appeal.id })
          .from(appeal)
          .where(and(eq(appeal.id, input.appealId), eq(appeal.status, "open")))
          .for("update")
          .limit(1);
        if (!openAppeal) {
          throw new ORPCError("BAD_REQUEST", { message: "This appeal has already been resolved." });
        }

        if (input.outcome === "overturned") {
          // The appeal contests a specific logged action. If a newer action of
          // the same kind has since replaced it (remove → restore → remove,
          // ban → unban → re-ban), overturning would reverse the NEWER state,
          // not the contested one — the same hazard `isActionCurrent`'s
          // live-state read cannot see.
          if (!(await isActionLatest(db, action))) {
            throw new ORPCError("BAD_REQUEST", {
              message: "A newer moderation action has superseded this one.",
            });
          }
          // `undoAction` runs on the runner's transaction, so its inverse
          // effects open savepoints, not real transactions — the send follows
          // the review's commit above, never an inner savepoint.
          pending = await undoAction(
            db,
            action,
            context.user.id,
            context.user.role ?? "user",
            input.note,
          );
        }

        await db
          .update(appeal)
          .set({
            status: input.outcome,
            reviewedBy: context.user.id,
            reviewNote: input.note,
            reviewedAt: new Date(),
          })
          .where(eq(appeal.id, input.appealId));

        await logAction(db, {
          action: "appeal_resolved",
          actorId: context.user.id,
          targetType: action.targetType,
          targetPostId: action.targetPostId ?? undefined,
          targetUserId: action.targetUserId ?? undefined,
          note: input.note,
          details: { outcome: input.outcome },
        });

        return { result: undefined, pending };
      });

      // The review's resolution notice to the appellant is NOT an effect's
      // owed notice — it goes out here, after the review commit, whatever the
      // outcome.
      await sendModerationEmail(context, row.appellantId, (locale) =>
        moderationResolutionEmail({ outcome: input.outcome, note: input.note }, locale),
      );
      return { appealId: input.appealId, status: input.outcome };
    }),
};
