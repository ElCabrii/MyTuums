import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  moderationBanEmail,
  moderationCaseResolutionEmail,
  moderationRemovalEmail,
  moderationResolutionEmail,
  moderationRoleEmail,
  moderationSuspensionEmail,
} from "@my-tuums/auth";
import { type Database } from "@my-tuums/db";
import { appeal, follow, moderationAction, post, report, session, user, userBlock } from "@my-tuums/db/schema";
import { appealToken } from "./appeal-token.js";
import {
  APPEALABLE_ACTIONS,
  emailUser,
  isActionCurrent,
  logAction,
  makeAppealUrl,
  restorePostEffect,
  stampReports,
  unbanEffect,
  undoAction,
  type ActionRow,
} from "./moderation-actions.js";
import {
  APPEAL_REASON_MAX_LENGTH,
  APPEAL_REASON_MIN_LENGTH,
  MODERATION_NOTE_MAX_LENGTH,
  MODERATION_PAGE_SIZE,
  MODERATION_PAGE_SIZE_MAX,
  POST_REPORT_REASONS,
  SUSPENSION_MAX_SECONDS,
  SUSPENSION_MIN_SECONDS,
  USER_REPORT_REASONS,
} from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import {
  baseProcedure,
  moderatorProcedure,
  protectedProcedure,
  rateLimit,
  staffProcedure,
} from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { canManageRole, roleAtLeast, roleRank, USER_ROLES } from "./roles.js";
import { publicUserColumns } from "./users.js";

/**
 * The moderation router (issue #38): reports, blocks, the moderator queue and
 * case view, the removal/suspension/ban/role actions, the audit log, and the
 * two appeal procedures.
 *
 * Every procedure is built from one of the role gates in procedures.ts plus
 * the `moderate` rate tier — except `appealOpen`, which is the app's one
 * public surface (a suspended user cannot sign in; the HMAC token is the
 * gate, so it deliberately carries no rate limit).
 */

/** A moderator's stated reason or note on an action. */
const noteInput = z.string().trim().max(MODERATION_NOTE_MAX_LENGTH).optional();

/** Whether a block exists between two users in either direction. */
async function hasBlockBetween(db: Database, a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ blockerId: userBlock.blockerId })
    .from(userBlock)
    .where(
      sql`(${userBlock.blockerId} = ${a} and ${userBlock.blockedId} = ${b})
           or (${userBlock.blockerId} = ${b} and ${userBlock.blockedId} = ${a})`,
    )
    .limit(1);
  return row !== undefined;
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

/** postgres.js surfaces constraint violations as errors carrying a code; 23505 is unique_violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

/** Opaque keyset cursor for the merged queue, tie-broken on the case id (text). */
const caseCursor = createCursorCodec(z.string().min(1));

/** One group of unresolved reports, raw from the GROUP BY. */
type ReportGroupRow = {
  target_type: "post" | "user";
  target_id: string;
  newest_at: Date;
  report_count: number;
  reasons: string[];
};

/** One open appeal, joined to its action's target. */
type OpenAppealRow = {
  id: string;
  reason: string;
  created_at: Date;
  target_type: "post" | "user";
  target_id: string;
};

const queueInput = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MODERATION_PAGE_SIZE_MAX).default(MODERATION_PAGE_SIZE),
});

const targetInput = z.discriminatedUnion("targetType", [
  z.object({ targetType: z.literal("post"), targetId: z.string().uuid() }),
  z.object({ targetType: z.literal("user"), targetId: z.string().min(1) }),
]);

const reportInput = z.discriminatedUnion("targetType", [
  z.object({
    targetType: z.literal("post"),
    targetId: z.string().uuid(),
    reason: z.enum(POST_REPORT_REASONS),
  }),
  z.object({
    targetType: z.literal("user"),
    targetId: z.string().min(1),
    reason: z.enum(USER_REPORT_REASONS),
  }),
]);

const resolveInput = z.discriminatedUnion("targetType", [
  z.object({
    targetType: z.literal("post"),
    targetId: z.string().uuid(),
    outcome: z.enum(["actioned", "dismissed"]),
    note: noteInput,
  }),
  z.object({
    targetType: z.literal("user"),
    targetId: z.string().min(1),
    outcome: z.enum(["actioned", "dismissed"]),
    note: noteInput,
  }),
]);

const suspensionInput = z.object({
  userId: z.string().min(1),
  reason: z.string().trim().min(1).max(MODERATION_NOTE_MAX_LENGTH),
  durationSeconds: z
    .number()
    .int()
    .min(SUSPENSION_MIN_SECONDS)
    .max(SUSPENSION_MAX_SECONDS),
});

export const moderationRouter = {
  /**
   * Reports a post or a user for one of the stable reason codes.
   *
   * Idempotent per (reporter, target): a repeat report refreshes the row's
   * timestamp and reopens it if it was resolved — the reporter never has to
   * remember whether they already spoke up. Self-reports and reports aimed
   * across a block (either direction) are rejected.
   */
  report: protectedProcedure
    .use(rateLimit(RATE_LIMITS.report))
    .input(reportInput)
    .handler(async ({ input, context }) => {
      if (input.targetType === "user" && input.targetId === context.user.id) {
        throw new ORPCError("BAD_REQUEST", { message: "You can't report yourself." });
      }

      const [target] =
        input.targetType === "post"
          ? await context.db
              .select({ id: post.id })
              .from(post)
              .where(eq(post.id, input.targetId))
              .limit(1)
          : await context.db
              .select({ id: user.id })
              .from(user)
              .where(eq(user.id, input.targetId))
              .limit(1);
      if (!target) throw new ORPCError("NOT_FOUND", { message: "The thing you reported doesn't exist." });

      if (
        input.targetType === "user" &&
        (await hasBlockBetween(context.db, context.user.id, input.targetId))
      ) {
        throw new ORPCError("BAD_REQUEST", { message: "You can't report this user." });
      }

      await context.db
        .insert(report)
        .values({
          reporterId: context.user.id,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: input.reason,
        })
        .onConflictDoUpdate({
          target: [report.reporterId, report.targetType, report.targetId],
          set: {
            resolvedAt: null,
            resolvedBy: null,
            resolvedOutcome: null,
            resolutionNote: null,
            createdAt: new Date(),
          },
          where: sql`${report.resolvedAt} is not null`,
        });

      return { reported: true };
    }),

  /**
   * Blocks a user. Silent by design — no email, no audit row, no likes
   * touched: it severs the follow edge in both directions and makes the two
   * invisible to each other (visibility.ts). Idempotent.
   */
  block: protectedProcedure
    .use(rateLimit(RATE_LIMITS.block))
    .input(z.object({ userId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      if (input.userId === context.user.id) {
        throw new ORPCError("BAD_REQUEST", { message: "You can't block yourself." });
      }
      const [target] = await context.db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, input.userId))
        .limit(1);
      if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });

      await context.db
        .delete(follow)
        .where(
          sql`(${follow.followerId} = ${context.user.id} and ${follow.followingId} = ${input.userId})
               or (${follow.followerId} = ${input.userId} and ${follow.followingId} = ${context.user.id})`,
        );
      await context.db
        .insert(userBlock)
        .values({ blockerId: context.user.id, blockedId: input.userId })
        .onConflictDoNothing();

      return { userId: input.userId, blocked: true };
    }),

  /** Unblocks a user. Silent and idempotent, like the block. */
  unblock: protectedProcedure
    .use(rateLimit(RATE_LIMITS.block))
    .input(z.object({ userId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, input.userId))
        .limit(1);
      if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });

      await context.db
        .delete(userBlock)
        .where(
          sql`${userBlock.blockerId} = ${context.user.id} and ${userBlock.blockedId} = ${input.userId}`,
        );

      return { userId: input.userId, blocked: false };
    }),

  /**
   * The moderation queue: unresolved reports grouped by target, merged with
   * open appeals, newest first.
   *
   * Two bounded queries (report groups, open appeals) merged in JS — the
   * union has no table of its own, and a full SQL union of two grouped
   * shapes would need twice the machinery for the same page. Keyset cursor
   * on `(newestAt desc, targetId desc)`.
   */
  queue: moderatorProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(queueInput)
    .handler(async ({ input, context }) => {
      const limit = input.limit;
      const decoded = input.cursor ? caseCursor.decode(input.cursor) : undefined;

      const reportGroups = await context.db.execute<ReportGroupRow>(sql`
        select ${report.targetType} as target_type,
               ${report.targetId} as target_id,
               max(${report.createdAt}) as newest_at,
               count(*)::int as report_count,
               array_agg(${report.reason}) as reasons
        from ${report}
        where ${report.resolvedAt} is null
        group by ${report.targetType}, ${report.targetId}
        ${decoded
          ? sql`having (max(${report.createdAt}), ${report.targetId}) < (${sql.param(decoded.createdAt, report.createdAt)}, ${sql.param(decoded.id, report.targetId)})`
          : sql``}
        order by newest_at desc, ${report.targetId} desc
        limit ${limit + 1}
      `);

      const openAppeals = await context.db.execute<OpenAppealRow>(sql`
        select ${appeal.id} as id,
               ${appeal.reason} as reason,
               ${appeal.createdAt} as created_at,
               ${moderationAction.targetType} as target_type,
               coalesce(${moderationAction.targetPostId}::text, ${moderationAction.targetUserId}) as target_id
        from ${appeal}
        inner join ${moderationAction} on ${moderationAction.id} = ${appeal.actionId}
        where ${appeal.status} = 'open'
        ${decoded
          ? sql`and (${appeal.createdAt}, coalesce(${moderationAction.targetPostId}::text, ${moderationAction.targetUserId})) < (${sql.param(decoded.createdAt, appeal.createdAt)}, ${sql.param(decoded.id, user.id)})`
          : sql``}
        order by ${appeal.createdAt} desc, target_id desc
        limit ${limit + 1}
      `);

      // Merge on the case key, keeping the newer half's timestamp as the
      // case's; a case with both reports and an appeal carries both.
      const byKey = new Map<string, MergedCase>();
      for (const group of reportGroups) {
        byKey.set(`${group.target_type}:${group.target_id}`, {
          targetType: group.target_type,
          targetId: group.target_id,
          newestAt: group.newest_at,
          reportCount: group.report_count,
          reasons: [...new Set(group.reasons)],
          appeal: null,
        });
      }
      for (const open of openAppeals) {
        const key = `${open.target_type}:${open.target_id}`;
        const entry: MergedCase = byKey.get(key) ?? {
          targetType: open.target_type,
          targetId: open.target_id,
          newestAt: open.created_at,
          reportCount: 0,
          reasons: [],
          appeal: null,
        };
        entry.appeal = { id: open.id, reason: open.reason, createdAt: open.created_at };
        if (open.created_at.getTime() > entry.newestAt.getTime()) entry.newestAt = open.created_at;
        byKey.set(key, entry);
      }

      const sorted = [...byKey.values()].sort(
        (a, b) =>
          b.newestAt.getTime() - a.newestAt.getTime() ||
          (a.targetId < b.targetId ? 1 : a.targetId > b.targetId ? -1 : 0),
      );
      const items = sorted.slice(0, limit);
      const last = sorted[limit];
      return {
        items,
        nextCursor: last ? caseCursor.encode(last.newestAt, last.targetId) : null,
      };
    }),

  /**
   * One moderation case: the target's full report history (resolved and not),
   * its open appeal if any, and a moderator projection of the target — raw
   * content for posts (tombstoned or not), account state for users.
   */
  case: moderatorProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(targetInput)
    .handler(async ({ input, context }) => {
      const reports = await context.db
        .select({
          reporterId: report.reporterId,
          reason: report.reason,
          createdAt: report.createdAt,
          resolvedAt: report.resolvedAt,
          resolvedBy: report.resolvedBy,
          resolvedOutcome: report.resolvedOutcome,
          resolutionNote: report.resolutionNote,
        })
        .from(report)
        .where(and(eq(report.targetType, input.targetType), eq(report.targetId, input.targetId)))
        .orderBy(desc(report.createdAt), desc(report.reporterId));

      const appealWhere =
        input.targetType === "post"
          ? eq(moderationAction.targetPostId, input.targetId)
          : eq(moderationAction.targetUserId, input.targetId);
      const [openAppeal] = await context.db
        .select({ id: appeal.id, reason: appeal.reason, createdAt: appeal.createdAt, status: appeal.status })
        .from(appeal)
        .innerJoin(moderationAction, eq(moderationAction.id, appeal.actionId))
        .where(
          and(
            eq(appeal.status, "open"),
            eq(moderationAction.targetType, input.targetType),
            appealWhere,
          ),
        )
        .orderBy(desc(appeal.createdAt))
        .limit(1);

      const target =
        input.targetType === "post"
          ? await (async () => {
              const [targetPost] = await context.db
                .select({
                  id: post.id,
                  content: post.content,
                  createdAt: post.createdAt,
                  parentId: post.parentId,
                  removedAt: post.removedAt,
                  removedBy: post.removedBy,
                  removedReason: post.removedReason,
                  author: {
                    id: user.id,
                    name: user.name,
                    username: user.username,
                    displayUsername: user.displayUsername,
                    image: user.image,
                  },
                })
                .from(post)
                .innerJoin(user, eq(user.id, post.authorId))
                .where(eq(post.id, input.targetId))
                .limit(1);
              if (!targetPost) {
                throw new ORPCError("NOT_FOUND", { message: "This post doesn't exist." });
              }
              return { kind: "post" as const, ...targetPost };
            })()
          : await (async () => {
              const [targetUser] = await context.db
                .select({
                  ...publicUserColumns,
                  role: user.role,
                  banned: user.banned,
                  banExpires: user.banExpires,
                  banReason: user.banReason,
                })
                .from(user)
                .where(eq(user.id, input.targetId))
                .limit(1);
              if (!targetUser) {
                throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });
              }
              return { kind: "user" as const, ...targetUser };
            })();

      return {
        targetType: input.targetType,
        targetId: input.targetId,
        reports,
        appeal: openAppeal ?? null,
        target,
      };
    }),

  /**
   * Resolves a case without acting on the target: stamps every open report,
   * emails each reporter, and logs `case_resolved`.
   */
  resolve: moderatorProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(resolveInput)
    .handler(async ({ input, context }) => {
      const { reporterIds } = await stampReports(context.db, {
        targetType: input.targetType,
        targetId: input.targetId,
        outcome: input.outcome,
        resolvedBy: context.user.id,
        note: input.note,
      });
      await logAction(context.db, {
        action: "case_resolved",
        actorId: context.user.id,
        targetType: input.targetType,
        targetPostId: input.targetType === "post" ? input.targetId : undefined,
        targetUserId: input.targetType === "user" ? input.targetId : undefined,
        note: input.note,
        details: { outcome: input.outcome, reporterCount: reporterIds.length },
      });
      for (const reporterId of reporterIds) {
        await emailUser(context.db, context.headers, reporterId, (locale) =>
          moderationCaseResolutionEmail({ outcome: input.outcome, note: input.note }, locale),
        );
      }
      return {
        targetType: input.targetType,
        targetId: input.targetId,
        resolved: reporterIds.length,
      };
    }),

  /**
   * Removes a post: tombstones it (feeds keep showing a bare stub), stamps
   * its open reports actioned, logs `post_removed`, and emails the author
   * quoting their post and linking the appeal.
   */
  removePost: moderatorProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(
      z.object({
        postId: z.string().uuid(),
        reason: z.string().trim().min(1).max(MODERATION_NOTE_MAX_LENGTH),
      }),
    )
    .handler(async ({ input, context }) => {
      const result = await context.db.transaction(async (tx) => {
        const [target] = await tx
          .select({ id: post.id, content: post.content, authorId: post.authorId, removedAt: post.removedAt })
          .from(post)
          .where(eq(post.id, input.postId))
          .for("update")
          .limit(1);
        if (!target) throw new ORPCError("NOT_FOUND", { message: "This post doesn't exist." });
        if (target.removedAt) {
          throw new ORPCError("BAD_REQUEST", { message: "This post is already removed." });
        }

        await tx
          .update(post)
          .set({ removedAt: new Date(), removedBy: context.user.id, removedReason: input.reason })
          .where(eq(post.id, input.postId));
        await stampReports(tx, {
          targetType: "post",
          targetId: input.postId,
          outcome: "actioned",
          resolvedBy: context.user.id,
          note: input.reason,
        });
        const action = await logAction(tx, {
          action: "post_removed",
          actorId: context.user.id,
          targetType: "post",
          targetPostId: input.postId,
          reason: input.reason,
        });
        return { authorId: target.authorId, content: target.content, actionId: action.id };
      });

      // Mail after the transaction commits: a failed send must not roll the
      // removal back, and the mail itself needs no transaction.
      await emailUser(context.db, context.headers, result.authorId, (locale) =>
        moderationRemovalEmail({
          postText: result.content,
          reason: input.reason,
          appealUrl: makeAppealUrl(result.actionId, result.authorId),
        }, locale),
      );
      return { postId: input.postId, removed: true };
    }),

  /** Restores a removed post: clears the tombstone, logs `post_restored`, emails the author. */
  restorePost: moderatorProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(z.object({ postId: z.string().uuid(), note: noteInput }))
    .handler(async ({ input, context }) => {
      await restorePostEffect(context.db, {
        postId: input.postId,
        actorId: context.user.id,
        note: input.note,
        headers: context.headers,
      });
      return { postId: input.postId, restored: true };
    }),

  /**
   * Suspends a user for a bounded time: bans the account with an expiry,
   * deletes every session (the account locks immediately), stamps open
   * user-target reports actioned, logs `user_suspended`, emails with the
   * expiry and the appeal link. Re-suspending an already-suspended account
   * just extends the clock.
   */
  suspendUser: moderatorProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(suspensionInput)
    .handler(async ({ input, context }) => {
      const result = await context.db.transaction(async (tx) => {
        const [target] = await tx
          .select({ id: user.id, role: user.role })
          .from(user)
          .where(eq(user.id, input.userId))
          .for("update")
          .limit(1);
        if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });
        // Rank guard: a moderator cannot suspend a moderator; nobody can
        // suspend themselves (an actor always holds their own rank).
        if (!canManageRole(context.user.role ?? "user", target.role ?? "user")) {
          throw new ORPCError("FORBIDDEN");
        }

        await tx
          .update(user)
          .set({
            banned: true,
            banReason: input.reason,
            banExpires: sql`now() + ${input.durationSeconds} * interval '1 second'`,
          })
          .where(eq(user.id, input.userId));
        // Every session dies with the suspension — the account is locked
        // until the clock runs out or a moderator lifts it.
        await tx.delete(session).where(eq(session.userId, input.userId));
        await stampReports(tx, {
          targetType: "user",
          targetId: input.userId,
          outcome: "actioned",
          resolvedBy: context.user.id,
          note: input.reason,
        });
        const action = await logAction(tx, {
          action: "user_suspended",
          actorId: context.user.id,
          targetType: "user",
          targetUserId: input.userId,
          reason: input.reason,
          details: { durationSeconds: input.durationSeconds },
        });
        return { actionId: action.id, expiresAt: new Date(Date.now() + input.durationSeconds * 1000) };
      });

      await emailUser(context.db, context.headers, input.userId, (locale) =>
        moderationSuspensionEmail({
          reason: input.reason,
          expiresAt: result.expiresAt,
          appealUrl: makeAppealUrl(result.actionId, input.userId),
        }, locale),
      );
      return { userId: input.userId, suspended: true, banExpires: result.expiresAt };
    }),

  /** Bans a user permanently — a suspension without an expiry. Same shape, staff+ gate. */
  banUser: staffProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(
      z.object({
        userId: z.string().min(1),
        reason: z.string().trim().min(1).max(MODERATION_NOTE_MAX_LENGTH),
      }),
    )
    .handler(async ({ input, context }) => {
      const result = await context.db.transaction(async (tx) => {
        const [target] = await tx
          .select({ id: user.id, role: user.role })
          .from(user)
          .where(eq(user.id, input.userId))
          .for("update")
          .limit(1);
        if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });
        if (!canManageRole(context.user.role ?? "user", target.role ?? "user")) {
          throw new ORPCError("FORBIDDEN");
        }

        await tx
          .update(user)
          .set({ banned: true, banReason: input.reason, banExpires: null })
          .where(eq(user.id, input.userId));
        await tx.delete(session).where(eq(session.userId, input.userId));
        await stampReports(tx, {
          targetType: "user",
          targetId: input.userId,
          outcome: "actioned",
          resolvedBy: context.user.id,
          note: input.reason,
        });
        const action = await logAction(tx, {
          action: "user_banned",
          actorId: context.user.id,
          targetType: "user",
          targetUserId: input.userId,
          reason: input.reason,
        });
        return { actionId: action.id };
      });

      await emailUser(context.db, context.headers, input.userId, (locale) =>
        moderationBanEmail({
          reason: input.reason,
          appealUrl: makeAppealUrl(result.actionId, input.userId),
        }, locale),
      );
      return { userId: input.userId, banned: true };
    }),

  /** Unbans or unsuspends a user — the code follows the expiry read (a clock running = suspension). */
  unbanUser: staffProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(z.object({ userId: z.string().min(1), note: noteInput }))
    .handler(async ({ input, context }) => {
      await unbanEffect(context.db, {
        userId: input.userId,
        actorId: context.user.id,
        note: input.note,
        headers: context.headers,
      });
      return { userId: input.userId, unbanned: true };
    }),

  /**
   * Changes a user's role, logging the swing and emailing them.
   *
   * The staff gate admits staff+; granting staff or admin is then still
   * admin-only, checked here because oRPC cannot vary the gate by input at
   * build time. The rank guard stops everyone from touching someone at or
   * above their own rank.
   */
  setRole: staffProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(z.object({ userId: z.string().min(1), role: z.enum(USER_ROLES) }))
    .handler(async ({ input, context }) => {
      if (
        roleRank(input.role) >= roleRank("staff") &&
        !roleAtLeast(context.user.role ?? "user", "admin")
      ) {
        throw new ORPCError("FORBIDDEN");
      }

      await context.db.transaction(async (tx) => {
        const [target] = await tx
          .select({ id: user.id, role: user.role })
          .from(user)
          .where(eq(user.id, input.userId))
          .for("update")
          .limit(1);
        if (!target) throw new ORPCError("NOT_FOUND", { message: "This account doesn't exist." });
        if (!canManageRole(context.user.role ?? "user", target.role ?? "user")) {
          throw new ORPCError("FORBIDDEN");
        }
        if (target.role === input.role) {
          throw new ORPCError("BAD_REQUEST", { message: `This account already has that role.` });
        }

        await tx.update(user).set({ role: input.role }).where(eq(user.id, input.userId));
        await logAction(tx, {
          action: "role_changed",
          actorId: context.user.id,
          targetType: "user",
          targetUserId: input.userId,
          details: { oldRole: target.role ?? "user", newRole: input.role },
        });
      });

      await emailUser(context.db, context.headers, input.userId, (locale) =>
        moderationRoleEmail({ role: input.role }, locale),
      );
      return { userId: input.userId, role: input.role };
    }),

  /** The moderation team: every account holding a role, ranked then by name. */
  team: staffProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .handler(async ({ context }) => {
      const rows = await context.db
        .select({
          id: user.id,
          name: user.name,
          username: user.username,
          displayUsername: user.displayUsername,
          image: user.image,
          role: user.role,
        })
        .from(user)
        .where(sql`${user.role} in ('moderator', 'staff', 'admin')`)
        .orderBy(
          sql`case ${user.role} when 'admin' then 0 when 'staff' then 1 else 2 end`,
          asc(user.name),
        );
      return { items: rows };
    }),

  /** The audit log: every moderation action, newest first, keyset-paginated. */
  auditLog: staffProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(queueInput)
    .handler(async ({ input, context }) => {
      const limit = input.limit;
      const decoded = input.cursor ? auditCursor.decode(input.cursor) : undefined;
      const rows = await context.db
        .select({
          id: moderationAction.id,
          action: moderationAction.action,
          actorId: moderationAction.actorId,
          targetType: moderationAction.targetType,
          targetPostId: moderationAction.targetPostId,
          targetUserId: moderationAction.targetUserId,
          reason: moderationAction.reason,
          note: moderationAction.note,
          details: moderationAction.details,
          createdAt: moderationAction.createdAt,
          actor: {
            id: actorTable.id,
            name: actorTable.name,
            username: actorTable.username,
            displayUsername: actorTable.displayUsername,
            image: actorTable.image,
          },
          targetUser: {
            id: targetUserTable.id,
            name: targetUserTable.name,
            username: targetUserTable.username,
            displayUsername: targetUserTable.displayUsername,
            image: targetUserTable.image,
          },
        })
        .from(moderationAction)
        .leftJoin(actorTable, eq(actorTable.id, moderationAction.actorId))
        .leftJoin(targetUserTable, eq(targetUserTable.id, moderationAction.targetUserId))
        .where(
          decoded
            ? sql`(${moderationAction.createdAt}, ${moderationAction.id}) < (${sql.param(decoded.createdAt, moderationAction.createdAt)}, ${sql.param(decoded.id, moderationAction.id)})`
            : undefined,
        )
        .orderBy(desc(moderationAction.createdAt), desc(moderationAction.id))
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      const last = rows[limit];
      return { items, nextCursor: last ? auditCursor.encode(last.createdAt, last.id) : null };
    }),

  /**
   * Opens an appeal — the app's ONE public surface (see `baseProcedure`).
   *
   * Either `token` (the signed-out HMAC link from the email) or `postId` (a
   * signed-in author appealing their own removed post) identifies the
   * action, exactly one of the two. Deliberately unthrottled: the
   * capability token IS the limiter, and a signature-valid link costs
   * nothing to honor.
   */
  appealOpen: baseProcedure
    .input(
      z.object({
        token: z.string().min(1).optional(),
        postId: z.string().uuid().optional(),
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
          throw new ORPCError("BAD_REQUEST", { message: "This appeal link is invalid or has expired." });
        }
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
              eq(moderationAction.action, "post_removed"),
              eq(moderationAction.targetPostId, postId),
            ),
          )
          .orderBy(desc(moderationAction.createdAt), desc(moderationAction.id))
          .limit(1);
        if (!removal) {
          throw new ORPCError("NOT_FOUND", { message: "This post has no removal to appeal." });
        }
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

      const [openAppeal] = await context.db
        .select({ id: appeal.id })
        .from(appeal)
        .where(and(eq(appeal.actionId, actionId), eq(appeal.status, "open")))
        .limit(1);
      if (openAppeal) {
        throw new ORPCError("BAD_REQUEST", { message: "There's already an open appeal for this action." });
      }

      try {
        const [inserted] = await context.db
          .insert(appeal)
          .values({ actionId, appellantId: userId, tokenNonce: nonce, reason: input.reason })
          .returning({ id: appeal.id });
        if (!inserted) throw new Error("appeal insert returned no row");
        return { appealId: inserted.id, status: "open" as const };
      } catch (error) {
        // The unique tokenNonce (or the partial unique open-per-action index)
        // caught a replay of a used link, or a racing duplicate open.
        if (isUniqueViolation(error)) {
          throw new ORPCError("BAD_REQUEST", { message: "This appeal link has already been used." });
        }
        throw error;
      }
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
        appealId: z.string().uuid(),
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

      if (input.outcome === "overturned") {
        await undoAction(context.db, action, context.user.id, input.note, context.headers);
      }

      await context.db
        .update(appeal)
        .set({
          status: input.outcome,
          reviewedBy: context.user.id,
          reviewNote: input.note,
          reviewedAt: new Date(),
        })
        .where(eq(appeal.id, input.appealId));

      await logAction(context.db, {
        action: "appeal_resolved",
        actorId: context.user.id,
        targetType: action.targetType,
        targetPostId: action.targetPostId ?? undefined,
        targetUserId: action.targetUserId ?? undefined,
        note: input.note,
        details: { outcome: input.outcome },
      });

      await emailUser(context.db, context.headers, row.appellantId, (locale) =>
        moderationResolutionEmail({ outcome: input.outcome, note: input.note }, locale),
      );
      return { appealId: input.appealId, status: input.outcome };
    }),
};

/** One merged queue case: reports and/or an appeal against a single target. */
type MergedCase = {
  targetType: "post" | "user";
  targetId: string;
  newestAt: Date;
  reportCount: number;
  reasons: string[];
  appeal: { id: string; reason: string; createdAt: Date } | null;
};

/** Opaque keyset cursor for the audit log, tie-broken on the action id (uuid). */
const auditCursor = createCursorCodec(z.uuid());

/** The `user` table joined twice for the audit log's actor and target summaries. */
const actorTable = alias(user, "actor");
const targetUserTable = alias(user, "target_user");
