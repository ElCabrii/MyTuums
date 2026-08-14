import { randomUUID } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { Database } from "@my-tuums/db";
import { appeal, moderationAction, post } from "@my-tuums/db/schema";
import { appealToken } from "./appeal-token.js";
import { APPEALABLE_ACTIONS } from "./constants.js";
import type { Context } from "./context.js";
import { isActionCurrent, isActionLatest, type ActionRow } from "./moderation-actions.js";
import { rateLimitCapability } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

/**
 * The deep appeal-intake module — the whole "open an appeal" flow behind
 * `moderation.appealOpen`, minus the transport.
 *
 * The oRPC procedure is deliberately thin: it validates the transport shape
 * (exactly one of `token`/`postId`, a session for the postId path) and then
 * delegates here. Everything else — the two source adapters, the normalized
 * target, the validity, replay and persistence rules — lives in this module,
 * so the procedure cannot drift from the rules and the rules are testable
 * through one small interface.
 *
 * The two sources are real adapters over the same internal target:
 *
 * - `openAppealFromToken` — the signed-out HMAC link from the notification
 *   email. A banned or suspended user cannot sign in, so this is the app's
 *   one anonymous surface; the token is the gate.
 * - `openAppealFromRemovedPost` — a signed-in author appealing their own
 *   removed post from the stub.
 *
 * Both resolve to an `AppealTarget` (the contested action, the appellant, and
 * the replay-protection nonce) and then run the same common tail: the action
 * must exist, be appealable, belong to the appellant, and still be in force;
 * the link must not be replayed and the action must not already be appealed;
 * and the insert must translate a unique-constraint race into the same
 * user-visible refusal as a plain replay.
 *
 * Rate limiting is part of the intake, not the transport: the capability key
 * (`appeal:<nonce>` or `appeal:<actionId>`) only exists after the adapter's
 * own branch work — an HMAC verify or the removal lookup — so it is consumed
 * here, at the exact point the key comes into existence, never as a
 * middleware that would have to run that work twice.
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

/**
 * The normalized appeal target both source adapters resolve to.
 *
 * `actionId` is the `moderation_action` row the appeal contests, `userId` the
 * account the action happened to, and `nonce` the replay-protection half —
 * stored on the `appeal` row (`tokenNonce`), so a used link cannot be
 * replayed. The token path takes its nonce from the token's payload; the
 * removed-post path mints a fresh one, because a signed-in author has no link
 * to replay and the nonce is only there to keep the two sources on one shape.
 */
interface AppealTarget {
  actionId: string;
  userId: string;
  nonce: string;
}

/**
 * The signed-out source adapter: verifies the HMAC token and resolves it to
 * an appeal target.
 *
 * The signature check is deliberately unthrottled: it is a cheap HMAC
 * comparison performed before any database work, and only a holder of a
 * valid link can get past it to consume budget. The budget lands here, keyed
 * on the link's nonce — the capability the caller presented, and unguessable
 * to anyone who does not hold the email.
 */
function targetFromToken(context: Context, token: string): AppealTarget {
  const payload = appealToken.verify(token);
  if (!payload) {
    throw new ORPCError("BAD_REQUEST", {
      message: "This appeal link is invalid or has expired.",
    });
  }
  // One budget per link, keyed on its nonce — the capability the caller
  // presented, and unguessable to anyone who does not hold the email. An
  // invalid signature is rejected above before any database work, so this
  // consume is only ever reached by someone holding a genuine link.
  rateLimitCapability(context, RATE_LIMITS.report, `appeal:${payload.nonce}`);
  return { actionId: payload.actionId, userId: payload.userId, nonce: payload.nonce };
}

/**
 * The signed-in source adapter: resolves a removed-post stub to an appeal
 * target, after proving the caller is the author.
 *
 * The latest removal record is what an appeal contests. The budget lands
 * here, after the one query that finds the action (its id is the key,
 * unknowable before this) and before the five that follow: the post and
 * ownership checks plus the common tail. A flood of postIds that never
 * resolve to a removal pays one lookup each and stops at NOT_FOUND; a
 * stranger probing a known-removed post can spend this action's 20/min, but
 * the email-token branch keys on its own nonce, so a legitimate appellant is
 * at worst delayed a minute on the signed-in path.
 */
async function targetFromRemovedPost(
  context: Context,
  sessionUser: { id: string },
  postId: string,
): Promise<AppealTarget> {
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
  return { actionId: removal.id, userId: sessionUser.id, nonce: randomUUID() };
}

/**
 * The common tail both sources run: the validity, replay and persistence
 * rules for one normalized appeal target.
 *
 * The action must exist, be appealable, belong to the target's user, and
 * still be in force (current AND latest — see `isActionCurrent` /
 * `isActionLatest`). Then one query covers both refusals: a REUSED link
 * (same nonce — a double click on the email) and a SECOND appeal against the
 * same action (a fresh link while one is in flight). They answer different
 * questions, so the nonce match wins: "your appeal was received, nothing to
 * do" is the true reading of a replayed link, and a fresh-link retry gets the
 * open-appeal message instead. A *reviewed* appeal is final — the action can
 * never be appealed again — so a prior row in any status closes this path
 * too.
 *
 * The insert is the last line of defence against a race: the unique
 * tokenNonce (or the partial unique open-per-action index) catches a replay
 * of a used link, or a racing duplicate open, and the unique-violation is
 * translated to the same user-visible refusal as a plain replay.
 */
async function openAppeal(
  context: Context,
  target: AppealTarget,
  reason: string,
): Promise<{ appealId: string; status: "open" }> {
  // The action must exist, be appealable, belong to the target's user,
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
    .where(eq(moderationAction.id, target.actionId))
    .limit(1);
  if (!actionRow) {
    throw new ORPCError("BAD_REQUEST", { message: "This appeal link is no longer valid." });
  }
  const action = actionRow as ActionRow;
  if (!APPEALABLE_ACTIONS.includes(action.action)) {
    throw new ORPCError("BAD_REQUEST", { message: "This action can't be appealed." });
  }
  const targetUserId = await actionTargetUser(context.db, action);
  if (!targetUserId || targetUserId !== target.userId) {
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
  // so the nonce match wins: "your appeal was received, nothing to do" is
  // the true reading of a replayed link, and a fresh-link retry gets the
  // open-appeal message instead. A *reviewed* appeal is final — the action
  // can never be appealed again (the schema comment and the resolution
  // email both promise that), so a prior row in any status closes this path
  // too.
  const [existing] = await context.db
    .select({ id: appeal.id, status: appeal.status, tokenNonce: appeal.tokenNonce })
    .from(appeal)
    .where(or(eq(appeal.actionId, target.actionId), eq(appeal.tokenNonce, target.nonce)))
    .limit(1);
  if (existing) {
    if (existing.tokenNonce === target.nonce) {
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
      .values({
        actionId: target.actionId,
        appellantId: target.userId,
        tokenNonce: target.nonce,
        reason,
      })
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
}

/**
 * Opens an appeal from the signed-out email link — the app's ONE public
 * surface (see `baseProcedure`). The token is verified, its nonce consumes
 * the `report` tier, and the common tail runs.
 */
export async function openAppealFromToken(
  context: Context,
  token: string,
  reason: string,
): Promise<{ appealId: string; status: "open" }> {
  const target = targetFromToken(context, token);
  return openAppeal(context, target, reason);
}

/**
 * Opens an appeal from a signed-in author's removed-post stub. The caller
 * must be the author (checked by the adapter), the removal's id consumes the
 * `report` tier, and the common tail runs.
 */
export async function openAppealFromRemovedPost(
  context: Context,
  sessionUser: { id: string },
  postId: string,
  reason: string,
): Promise<{ appealId: string; status: "open" }> {
  const target = await targetFromRemovedPost(context, sessionUser, postId);
  return openAppeal(context, target, reason);
}
