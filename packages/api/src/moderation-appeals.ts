import { and, desc, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Context } from "./context.js";
import { moderationAction, post } from "@my-tuums/db/schema";
import { actionTargetUser, openAppeal } from "./appeal-intake.js";
import { APPEAL_TOKEN_MAX_LENGTH } from "./appeal-token.js";
import { APPEAL_REASON_MAX_LENGTH, APPEAL_REASON_MIN_LENGTH } from "./constants.js";
import type { ActionRow } from "./moderation-actions.js";
import { reviewAppeal } from "./appeal-review.js";
import { noteInput } from "./moderation-inputs.js";
import { postAttachmentsSelection } from "./post-media.js";
import { baseProcedure, moderatorProcedure, protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

/**
 * The three appeal procedures: `appealOpen` — the app's ONE public surface (a
 * suspended user cannot sign in; the HMAC token is the gate) — `appealPreview`,
 * the author-gated look at the post an appeal is about, and `appealReview`,
 * the moderator's uphold-or-overturn decision.
 *
 * Intake and review are deliberately different shapes. `appealOpen` is a thin
 * transport seam over `./appeal-intake.ts`, which owns the whole intake
 * lifecycle: the two capability sources, the budget each spends, the validity
 * gates, the replay policy and the insert race. `appealReview` delegates to
 * `./appeal-review.ts`, which composes inverse effects with the decision in
 * one D1 batch.
 */

/**
 * The refusal a preview earns when the action it names does not exist or does
 * not belong to the caller.
 *
 * Deliberately one message for both, and deliberately the same wording intake
 * uses for the same pair of cases: a link handed onward must not reveal
 * whether the action it names exists.
 */
const APPEAL_LINK_INVALID = "This appeal link is no longer valid.";

/**
 * Which moderation action a preview request names.
 *
 * The same two identifiers the appeal page carries, and the same reading of
 * them intake does — the email link's token holds the action id, and a removed
 * post's id resolves to its latest removal. What is deliberately different is
 * that neither identifier is trusted to say WHO: the token's signature is
 * verified only so its payload can be read, and the caller's session is what
 * authorizes the result a step later. So this spends no appeal budget and
 * takes no lock; loading the page must not consume the capability that
 * submitting it needs.
 */
async function previewActionId(
  context: Pick<Context, "db" | "appealToken">,
  input: { token?: string; postId?: string },
): Promise<string> {
  if ((input.token ? 1 : 0) + (input.postId ? 1 : 0) !== 1) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Provide either an appeal link or the removed post.",
    });
  }

  if (input.token) {
    const payload = await context.appealToken.verify(input.token);
    if (!payload) {
      throw new ORPCError("BAD_REQUEST", {
        message: "This appeal link is invalid or has expired.",
      });
    }
    return payload.actionId;
  }

  const [removal] = await context.db
    .select({ id: moderationAction.id })
    .from(moderationAction)
    .where(
      and(
        // Redundant against the target-match check constraint, but it is what
        // lets the planner use `moderation_action_target_idx` — the same
        // reasoning as the identical clause in `./appeal-intake.ts`.
        eq(moderationAction.targetType, "post"),
        eq(moderationAction.action, "post_removed"),
        eq(moderationAction.targetPostId, input.postId!),
      ),
    )
    .orderBy(desc(moderationAction.createdAt), desc(moderationAction.id))
    .limit(1);
  if (!removal) {
    throw new ORPCError("NOT_FOUND", { message: "This post has no removal to appeal." });
  }
  return removal.id;
}

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
   * The post an appeal is about, shown to the author contesting it.
   *
   * A removal takes the post's content away from every reader — `postSelection`
   * nulls `content` and drops the attachments for the author too — so without
   * this the appeal page asks someone to argue about something it will not
   * show them. This is the author-gated counterpart of the moderator
   * projection in `./moderation-queue.ts`: raw content and tombstoned
   * attachments, for exactly one person.
   *
   * Session-gated, unlike `appealOpen`, and that is the whole design. A post
   * removal suspends nobody, so its author can always sign in — which means
   * the attachments can come back through the ordinary `/media/` route
   * (`canViewPostMedia` exempts an author from the removal tombstone) instead
   * of the app needing a second, anonymous way to reach object storage. A
   * signed-out visitor — someone holding a suspension or ban link — simply
   * gets no preview, and the appeal form below it still works: `appealOpen`
   * stays the one public surface, exactly as before.
   *
   * Deliberately NOT gated on contestability. Whether an action may still be
   * appealed is `appealOpen`'s question, and asking it here would mean taking
   * intake's write locks on a read. Showing authors their own post cannot
   * disclose anything to them they did not write; the submit is what refuses.
   */
  appealPreview: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(
      z.object({
        token: z.string().min(1).max(APPEAL_TOKEN_MAX_LENGTH).optional(),
        postId: z.uuid().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const actionId = await previewActionId(context, input);
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
      if (!actionRow) throw new ORPCError("BAD_REQUEST", { message: APPEAL_LINK_INVALID });

      // SAFETY: This select lists every ActionRow field, and the schema's
      // action check constraint restricts the stored code to
      // ModerationActionCode.
      const action = actionRow as ActionRow;
      const targetUserId = await actionTargetUser(context.db, action);
      if (!targetUserId || targetUserId !== context.user.id) {
        throw new ORPCError("BAD_REQUEST", { message: APPEAL_LINK_INVALID });
      }

      // A suspension or ban has no post behind it. That is a successful
      // preview of nothing, not a refusal: the page renders its form alone,
      // the same thing it did before this procedure existed.
      if (action.targetType !== "post" || !action.targetPostId) return { post: null };

      const [target] = await context.db
        .select({
          id: post.id,
          content: post.content,
          createdAt: post.createdAt,
          removedReason: post.removedReason,
          // Tombstoned attachments included: the objects survive a removal on
          // purpose, so a restore is lossless. An author-deleted post has had
          // its rows reaped with its objects, so this correctly reads empty.
          attachments: postAttachmentsSelection(true),
        })
        .from(post)
        .where(eq(post.id, action.targetPostId))
        .limit(1);
      return { post: target ?? null };
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
    .handler(({ input, context }) =>
      reviewAppeal(context, {
        ...input,
        actorId: context.user.id,
        actorRole: context.user.role ?? "user",
      }),
    ),
};
