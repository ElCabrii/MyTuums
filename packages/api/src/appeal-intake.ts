/**
 * Appeal intake: turning "this action was wrong" into an open `appeal` row, or
 * into the exact refusal that claim earns.
 *
 * Everything a caller has to know to safely open an appeal — which capability
 * identifies the contested action, what budget that capability spends, whether
 * the action is still contestable, whether this attempt is a replay, and how a
 * lost insert race reads back to the appellant — lives here.
 * `moderation.appealOpen` expresses *what* it wants (`openAppeal`) and this
 * module owns *how*.
 *
 * The deletion test: delete this module and the branch ordering (verify before
 * any database work, budget at the exact point the key exists), the
 * appealable/current/latest gates, the nonce-versus-action replay precedence
 * and the unique-violation translation would all have to move back into the
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
 * still in force or still the latest of its kind is `./moderation-actions.ts`;
 * budget accounting is `./procedures.ts`. None of it is duplicated here.
 * Appeal *review* — the uphold/overturn decision and the moderation reversal
 * it applies — is deliberately not intake's business and stays in
 * `./moderation-appeals.ts`.
 */

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
 * What intake reads from the request context.
 *
 * Narrower than `Context` on purpose: intake touches the database, the
 * caller's session and the rate limiter, and nothing else. It never sends a
 * notice, so it needs neither `headers` nor `storage` — the naming of what it
 * cannot reach is half of what keeps review's concerns out of intake.
 */
export type AppealIntakeContext = Pick<Context, "db" | "session" | "rateLimiter">;

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
 * Whether a thrown error is postgres' `unique_violation` (SQLSTATE 23505).
 *
 * postgres.js puts the code on the error it throws, but drizzle wraps every
 * driver failure in a `DrizzleQueryError` that carries the original as its
 * `cause` — so the code is NOT on the error a query builder rejects with, and
 * matching only the top level lets a genuine constraint race escape as a 500
 * instead of the caller-facing refusal below. Walking the `cause` chain is
 * what makes the check survive that wrapping (and any future layer that adds
 * one); the depth bound is a guard against a self-referential chain, not a
 * real limit — the chains this sees are one link long.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

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
function fromEmailToken(context: AppealIntakeContext, token: string): AppealTarget {
  const payload = appealToken.verify(token);
  if (!payload) {
    throw new ORPCError("BAD_REQUEST", {
      message: "This appeal link is invalid or has expired.",
    });
  }
  rateLimitCapability(context, RATE_LIMITS.report, `appeal:${payload.nonce}`);
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

  // A session is not a one-time capability, so this attempt gets a fresh nonce
  // and the "one open appeal per action" rule is what stops the second try.
  return { actionId: removal.id, appellantId: sessionUser.id, nonce: randomUUID() };
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
 * Proves the action a target names is one this appellant may still contest.
 *
 * Four gates, source-blind by construction: the action exists, it is one of
 * the appealable kinds, it happened to *this* appellant, and it is both still
 * in force (`isActionCurrent` reads live state) and still the latest of its
 * kind (`isActionLatest` reads the log). The last two answer different
 * questions — remove → restore → remove leaves the first removal's live-state
 * check reading the *second* tombstone as current — so both are required.
 *
 * "No longer valid" is deliberately the same wording for a vanished action and
 * for one belonging to someone else: a link handed onward must not reveal
 * whether the action it names exists.
 */
async function assertContestable(db: Database, target: AppealTarget): Promise<void> {
  const [actionRow] = await db
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
  const targetUserId = await actionTargetUser(db, action);
  if (!targetUserId || targetUserId !== target.appellantId) {
    throw new ORPCError("BAD_REQUEST", { message: "This appeal link is no longer valid." });
  }
  if (!(await isActionCurrent(db, action))) {
    throw new ORPCError("BAD_REQUEST", {
      message: "There's nothing to appeal anymore — this action was already undone.",
    });
  }
  if (!(await isActionLatest(db, action))) {
    throw new ORPCError("BAD_REQUEST", {
      message: "A newer moderation action has superseded this one.",
    });
  }
}

/**
 * Refuses an attempt an earlier appeal already answered.
 *
 * One query covers both refusals: a REUSED link (same nonce — a double click
 * on the email) and a SECOND appeal against the same action (a fresh link
 * while one is in flight). They answer different questions, so the nonce match
 * wins: "your appeal was received, nothing to do" is the true reading of a
 * replayed link, and a fresh-link retry gets the open-appeal message instead.
 * A *reviewed* appeal is final — the action can never be appealed again (the
 * schema comment and the resolution email both promise that), so a prior row
 * in any status closes this path too.
 *
 * This is the readable half of the rule. The database holds the other half —
 * see {@link insertAppeal} — because two attempts can pass this check at once.
 */
async function refuseReplay(db: Database, target: AppealTarget): Promise<void> {
  const [existing] = await db
    .select({ id: appeal.id, status: appeal.status, tokenNonce: appeal.tokenNonce })
    .from(appeal)
    .where(or(eq(appeal.actionId, target.actionId), eq(appeal.tokenNonce, target.nonce)))
    .limit(1);
  if (!existing) return;
  if (existing.tokenNonce === target.nonce) {
    throw new ORPCError("BAD_REQUEST", { message: "This appeal link has already been used." });
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

/**
 * Writes the row, letting the database settle the races {@link refuseReplay}
 * cannot.
 *
 * The unique `token_nonce` column and the partial unique open-per-action index
 * are the authority: two concurrent attempts can both read "no existing
 * appeal" and only one can commit. The loser is translated to the used-link
 * refusal rather than surfacing a 500, which is the same answer it would have
 * got a moment later from the read.
 */
async function insertAppeal(
  db: Database,
  target: AppealTarget,
  reason: string,
): Promise<OpenedAppeal> {
  let inserted: { id: string } | undefined;
  try {
    [inserted] = await db
      .insert(appeal)
      .values({
        actionId: target.actionId,
        appellantId: target.appellantId,
        tokenNonce: target.nonce,
        reason,
      })
      .returning({ id: appeal.id });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ORPCError("BAD_REQUEST", { message: "This appeal link has already been used." });
    }
    throw error;
  }
  // Outside the catch on purpose: this is a "cannot happen" guard on the
  // insert's own result, not a database error the unique-violation branch
  // above should ever be asked to classify.
  if (!inserted) throw new Error("appeal insert returned no row");
  return { appealId: inserted.id, status: "open" };
}

/**
 * Opens an appeal, or throws the refusal the attempt earned.
 *
 * The order is load-bearing and is the reason this is one function rather than
 * a set of steps a caller sequences:
 *
 * 1. **Authenticate the source.** Exactly one capability, verified by its own
 *    adapter. For the email link that is an HMAC comparison before any
 *    database work, so an anonymous caller with a bad signature never reaches
 *    Postgres at all.
 * 2. **Spend the capability's budget**, inside the adapter, at the point its
 *    key comes into existence — the link's nonce, or the removal's id. Every
 *    query after this point is paid for.
 * 3. **Prove the action contestable** — appealable, this appellant's, current,
 *    latest.
 * 4. **Refuse a replay**, then insert and let the unique constraints settle
 *    what the read could not.
 *
 * No notice is sent and no moderation state changes: intake records a request
 * to be heard, and `moderation.appealReview` is what answers it.
 */
export async function openAppeal(
  context: AppealIntakeContext,
  request: AppealRequest,
): Promise<OpenedAppeal> {
  const target = await resolveTarget(context, request);
  await assertContestable(context.db, target);
  await refuseReplay(context.db, target);
  return insertAppeal(context.db, target, request.reason);
}
