/**
 * Appeal intake: turning "this action was wrong" into an open `appeal` row, or
 * into the exact refusal that claim earns.
 *
 * Everything a caller has to know to safely open an appeal — which capability
 * identifies the contested action, what budget that capability spends, whether
 * the action is still contestable, whether this attempt is a replay, and how a
 * concurrent attempt reads back to the appellant — lives here.
 * `moderation.appealOpen` expresses *what* it wants (`openAppeal`) and this
 * module owns *how*.
 *
 * The deletion test: delete this module and the branch ordering (verify before
 * any database work, budget at the exact point the key exists), the
 * appealable/current/latest gates, the nonce-versus-action replay precedence
 * and atomic persistence would all have to move back into the
 * one anonymous procedure — plus into any future surface that opens an appeal.
 *
 * ## Two sources, one target
 *
 * An appeal arrives from one of two capabilities, and they are genuinely
 * different things: the signed-out email link is an HMAC token the appellant
 * holds, and the signed-in stub is a session plus a post the appellant wrote.
 * Each source is its own adapter — it authenticates its own claim and spends
 * its own budget — and each normalises to the same {@link AppealTarget}: the
 * contested action, the appellant it belongs to, and the nonce that makes this
 * attempt replayable exactly once. Everything after the adapters is source-blind.
 *
 * ## What stays outside
 *
 * Signing and verifying links is `./appeal-token.ts`; whether an action is
 * still in force or still the latest of its kind is `./moderation-action-state.ts`;
 * budget accounting is `./procedures.ts`. None of it is duplicated here.
 * Appeal *review* — the uphold/overturn decision and the moderation reversal
 * it applies — is deliberately not intake's business and stays in
 * `./moderation-appeals.ts`.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { appeal, moderationAction, post } from "@my-tuums/db/schema";
import { APPEALABLE_ACTIONS } from "./constants.js";
import type { Context } from "./context.js";
import type { ActionRow, DbLike } from "./moderation-actions.js";
import { moderationActionState } from "./moderation-action-state.js";
import { rateLimitCapability } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

/**
 * What intake reads from the request context.
 *
 * Narrower than `Context` on purpose: intake touches the database, the
 * caller's session and the rate limiter, and nothing else. It never sends a
 * notice, so it needs neither `headers` nor `storage` — the naming of what it
 * cannot reach is half of what keeps review's concerns out of intake.
 */
export type AppealIntakeContext = Pick<Context, "db" | "session" | "rateLimiter" | "appealToken">;

/** What a caller presents: exactly one capability, plus the appellant's own words. */
export interface AppealRequest {
  /** The signed link from the notification email — the signed-out capability. */
  token?: string;
  /** The removed post a signed-in author is appealing from its stub. */
  postId?: string;
  /** The appellant's stated case, already bounded by the procedure's schema. */
  reason: string;
}

/** What a successful intake produces. */
export interface OpenedAppeal {
  appealId: string;
  status: "open";
}

/**
 * One authenticated claim, normalised — what both sources produce and
 * everything downstream consumes.
 *
 * `nonce` is the replay key. The email link carries its own (minted when the
 * notice was sent, stored on the row it opens, so the same link can never open
 * a second appeal); the stub path mints a fresh one per attempt, because a
 * session is not a one-time capability and the stub's replay protection is the
 * one-open-appeal-per-action rule instead.
 */
interface AppealTarget {
  actionId: string;
  appellantId: string;
  nonce: string;
}

/**
 * The user an action happened to — its target user, or the author for post
 * actions.
 *
 * Exported because it is the same question `moderation.appealPreview` has to
 * answer before it will show anyone a removed post: "is this action yours?".
 * One definition, so the read surface and the write surface cannot disagree
 * about who an action belongs to.
 */
export async function actionTargetUser(db: DbLike, action: ActionRow): Promise<string | null> {
  if (action.targetType === "user") return action.targetUserId;
  if (!action.targetPostId) return null;
  const [target] = await db
    .select({ authorId: post.authorId })
    .from(post)
    .where(eq(post.id, action.targetPostId))
    .limit(1);
  return target?.authorId ?? null;
}

/**
 * The email-link source: an HMAC capability, verified before anything costs
 * anything.
 *
 * The signature check is deliberately unthrottled — it is a cheap comparison
 * performed before any database work, and only the link's holder can get past
 * it to consume budget. The budget then lands on the link's own nonce, which
 * is unguessable to anyone who does not hold the email, so one link's replays
 * can never exhaust another appellant's.
 */
async function fromEmailToken(context: AppealIntakeContext, token: string): Promise<AppealTarget> {
  const payload = await context.appealToken.verify(token);
  if (!payload) {
    throw new ORPCError("BAD_REQUEST", {
      message: "This appeal link is invalid or has expired.",
    });
  }
  await rateLimitCapability(context, RATE_LIMITS.report, `appeal:${payload.nonce}`);
  return { actionId: payload.actionId, appellantId: payload.userId, nonce: payload.nonce };
}

/**
 * The removed-post-stub source: a session plus authorship of the removed post.
 *
 * There is no token to verify, so the capability is proven by two reads — the
 * latest removal against the post (what an appeal contests) and the post's
 * author (who is allowed to contest it). The budget lands between them, at the
 * exact point its key exists: after the one query that finds the action (its
 * id is the key, unknowable before this) and before the ownership check plus
 * the common tail. A flood of postIds that never resolve to a removal pays one
 * lookup each and stops at NOT_FOUND; a stranger probing a known-removed post
 * can spend that action's 20/min, but the email-link source keys on its own
 * nonce, so a legitimate appellant is at worst delayed a minute here.
 *
 * The session is read off the context rather than through `context.user`:
 * intake serves the app's one anonymous procedure, which has no session
 * guarantee for `protectedProcedure` to have added one.
 */
async function fromRemovedPostStub(
  context: AppealIntakeContext,
  postId: string,
): Promise<AppealTarget> {
  const sessionUser = context.session?.user;
  if (!sessionUser) throw new ORPCError("UNAUTHORIZED");

  const [removal] = await context.db
    .select({ id: moderationAction.id })
    .from(moderationAction)
    .where(
      and(
        // Redundant — the `moderation_action_target_match` check constraint
        // guarantees a post target has target_type = 'post' — but it is what
        // lets the planner use `moderation_action_target_idx`, whose leading
        // column is target_type (issue #55).
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

  await rateLimitCapability(context, RATE_LIMITS.report, `appeal:${removal.id}`);

  const [target] = await context.db
    .select({ authorId: post.authorId })
    .from(post)
    .where(eq(post.id, postId))
    .limit(1);
  if (!target) throw new ORPCError("NOT_FOUND", { message: "This post doesn't exist." });
  if (target.authorId !== sessionUser.id) {
    throw new ORPCError("FORBIDDEN", { message: "You can only appeal your own posts." });
  }

  // A session is not a one-time capability, so this attempt gets a fresh nonce
  // and the "one open appeal per action" rule is what stops the second try.
  return { actionId: removal.id, appellantId: sessionUser.id, nonce: crypto.randomUUID() };
}

/**
 * Picks the source and authenticates the claim through it.
 *
 * Exactly one capability, never both and never neither: the two are different
 * proofs of the same right, and accepting both would leave it ambiguous which
 * one was actually checked.
 */
async function resolveTarget(
  context: AppealIntakeContext,
  request: AppealRequest,
): Promise<AppealTarget> {
  if ((request.token ? 1 : 0) + (request.postId ? 1 : 0) !== 1) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Provide either an appeal link or the removed post.",
    });
  }
  if (request.token) return fromEmailToken(context, request.token);
  return await fromRemovedPostStub(context, request.postId!);
}

/**
 * A single ordered refusal expression guards the insert and explains a rejected
 * attempt. D1 serializes the batch, so neither a competing intake nor a manual
 * reversal can pass between validation and persistence. Nonce reuse wins over
 * an existing appeal for the action, even when those matches are different rows.
 */
function intakeRefusal(target: AppealTarget) {
  return sql<string | null>`case
    when moderation_action.action not in
      (select value from json_each(${JSON.stringify(APPEALABLE_ACTIONS)}))
      then 'This action can''t be appealed.'
    when ${moderationActionState.recipientId} is not ${target.appellantId}
      then 'This appeal link is no longer valid.'
    when not (${moderationActionState.current})
      then 'There''s nothing to appeal anymore — this action was already undone.'
    when not (${moderationActionState.latest})
      then 'A newer moderation action has superseded this one.'
    when exists (select 1 from ${appeal} where ${appeal.tokenNonce} = ${target.nonce})
      then 'This appeal link has already been used.'
    when exists (select 1 from ${appeal}
      where ${appeal.actionId} = ${target.actionId} and ${appeal.status} = 'open')
      then 'There''s already an open appeal for this action.'
    when exists (select 1 from ${appeal} where ${appeal.actionId} = ${target.actionId})
      then 'This action has already been appealed, and the review is final.'
    else null end`;
}

/**
 * Authenticate and budget the capability before any common database work,
 * then atomically check eligibility and insert. The second statement explains
 * a refused insert from the same serialized batch; successful inserts ignore
 * that read because their own newly persisted nonce is now spent.
 */
export async function openAppeal(
  context: AppealIntakeContext,
  request: AppealRequest,
): Promise<OpenedAppeal> {
  const target = await resolveTarget(context, request);
  const refusal = intakeRefusal(target);
  const id = crypto.randomUUID();
  const [inserted, reasons] = await context.db.batch([
    context.db
      .insert(appeal)
      .select(
        sql`select ${id}, ${target.actionId},
      ${target.appellantId}, ${target.nonce}, ${request.reason}, 'open', null, null,
      cast(unixepoch('subsec') * 1000 as integer), null
      from ${moderationAction}
      where ${moderationAction.id} = ${target.actionId} and (${refusal}) is null`,
      )
      .returning({ id: appeal.id }),
    context.db
      .select({ refusal })
      .from(moderationAction)
      .where(eq(moderationAction.id, target.actionId)),
  ]);
  if (inserted[0]) return { appealId: inserted[0].id, status: "open" };
  throw new ORPCError("BAD_REQUEST", {
    message: reasons[0]?.refusal ?? "This appeal link is no longer valid.",
  });
}
