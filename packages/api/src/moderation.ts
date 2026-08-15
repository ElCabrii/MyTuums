import { asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Database } from "@my-tuums/db";
import { follow, moderationAction, post, report, user, userBlock } from "@my-tuums/db/schema";
import {
  MODERATION_NOTE_MAX_LENGTH,
  POST_REPORT_REASONS,
  SUSPENSION_MAX_SECONDS,
  SUSPENSION_MIN_SECONDS,
  USER_REPORT_REASONS,
} from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { appealsRouter } from "./moderation-appeals.js";
import {
  banUserEffect,
  removePostEffect,
  restorePostEffect,
  sendPendingEmails,
  setRoleEffect,
  suspendUserEffect,
  unbanEffect,
} from "./moderation-actions.js";
import { noteInput, queueInput } from "./moderation-inputs.js";
import { queueRouter } from "./moderation-queue.js";
import { keysetPage } from "./pagination.js";
import { moderatorProcedure, protectedProcedure, rateLimit, staffProcedure } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { roleAtLeast, roleRank, USER_ROLES } from "./roles.js";
import { publicUserColumns } from "./users.js";

/**
 * The moderation router (issue #38): reports, blocks, the staff actions and
 * the audit log. The triage procedures (queue, case, resolve) live in
 * ./moderation-queue.ts and the two appeal procedures in
 * ./moderation-appeals.ts; this file assembles all three into
 * `moderationRouter` and holds the user-facing procedures and the actions.
 *
 * Every procedure is built from one of the role gates in procedures.ts plus
 * a rate tier from RATE_LIMITS — except `appealOpen`, the app's one public
 * surface (a suspended user cannot sign in; the HMAC token is the gate). It
 * is not unthrottled for that: it consumes its own budget on the `report`
 * tier, keyed on the capability the caller presented rather than on a
 * session (see `rateLimitCapability` in procedures.ts).
 */

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

const reportInput = z.discriminatedUnion("targetType", [
  z.object({
    targetType: z.literal("post"),
    targetId: z.uuid(),
    reason: z.enum(POST_REPORT_REASONS),
  }),
  z.object({
    targetType: z.literal("user"),
    targetId: z.string().min(1),
    reason: z.enum(USER_REPORT_REASONS),
  }),
]);

const suspensionInput = z.object({
  userId: z.string().min(1),
  reason: z.string().trim().min(1).max(MODERATION_NOTE_MAX_LENGTH),
  durationSeconds: z.number().int().min(SUSPENSION_MIN_SECONDS).max(SUSPENSION_MAX_SECONDS),
});

export const moderationRouter = {
  // The triage procedures (queue, case, resolve) and the two appeal
  // procedures live in their own files; the spreads assemble them here.
  ...queueRouter,
  ...appealsRouter,

  /**
   * Reports a post or a user for one of the stable reason codes.
   *
   * Idempotent per (reporter, target): a repeat report refreshes the row's
   * timestamp — an open case stays on top of the queue, a resolved one
   * reopens — while the FIRST reason is kept, so the reporter never has to
   * remember whether they already spoke up and moderators keep the reason
   * they saw first (the test suite pins that contract). Self-reports are
   * rejected, and user reports aimed across a block (either direction) are
   * rejected too — post reports across a block are allowed, because the
   * block hides the author from the viewer, not the evidence from the
   * moderators.
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
      if (!target)
        throw new ORPCError("NOT_FOUND", { message: "The thing you reported doesn't exist." });

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
            // A repeat report refreshes the case's clock whether the row is
            // open or resolved (docs/product.md: "a repeat report refreshes
            // the row's timestamp without creating a new one"). `reason` is
            // deliberately NOT in the set: the first reason is the one the
            // moderators saw (moderation.int.test.ts pins "reason is fixed
            // at first report").
            createdAt: new Date(),
          },
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

      // The follow sever and the block row commit together: two bare
      // statements would let a mid-failure leave the follows deleted with no
      // block in place — the severs are the block's side effect, not a
      // standalone action.
      await context.db.transaction(async (tx) => {
        await tx.delete(follow).where(
          sql`(${follow.followerId} = ${context.user.id} and ${follow.followingId} = ${input.userId})
                 or (${follow.followerId} = ${input.userId} and ${follow.followingId} = ${context.user.id})`,
        );
        await tx
          .insert(userBlock)
          .values({ blockerId: context.user.id, blockedId: input.userId })
          .onConflictDoNothing();
      });

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
   * The viewer's blocked users, newest block first — the settings page's
   * "Blocked users" list. Deliberately not paginated: unlike every feed, the
   * list is personal, bounded by the block rate tier, and read in full on a
   * single settings screen — a keyset cursor would buy nothing here.
   */
  listBlocked: protectedProcedure.use(rateLimit(RATE_LIMITS.block)).handler(async ({ context }) => {
    const rows = await context.db
      .select({
        ...publicUserColumns,
        blockedAt: userBlock.createdAt,
      })
      .from(userBlock)
      .innerJoin(user, eq(user.id, userBlock.blockedId))
      .where(eq(userBlock.blockerId, context.user.id))
      .orderBy(desc(userBlock.createdAt), desc(userBlock.blockedId));
    return { items: rows };
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
        postId: z.uuid(),
        reason: z.string().trim().min(1).max(MODERATION_NOTE_MAX_LENGTH),
      }),
    )
    .handler(async ({ input, context }) => {
      // The effect commits the tombstone + stamps + audit row, then the
      // author is emailed — a failed send must not roll the removal back.
      const { pending } = await removePostEffect(context.db, {
        postId: input.postId,
        actorId: context.user.id,
        reason: input.reason,
      });
      await sendPendingEmails(context.db, context.headers, [pending], context.emailSender);
      return { postId: input.postId, removed: true };
    }),

  /** Restores a removed post: clears the tombstone, logs `post_restored`, emails the author. */
  restorePost: moderatorProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(z.object({ postId: z.uuid(), note: noteInput }))
    .handler(async ({ input, context }) => {
      // The effect commits the tombstone clear + audit row, then the author
      // is emailed — and an already-restored post (a race with the appeal
      // overturn) owes no email: nothing happened.
      const pending = await restorePostEffect(context.db, {
        postId: input.postId,
        actorId: context.user.id,
        note: input.note,
      });
      await sendPendingEmails(context.db, context.headers, pending, context.emailSender);
      return { postId: input.postId, restored: true };
    }),

  /**
   * Suspends a user for a bounded time: bans the account with an expiry,
   * deletes every session (the account locks immediately), stamps open
   * user-target reports actioned, logs `user_suspended`, emails with the
   * expiry and the appeal link. Re-suspending an already-suspended account
   * just extends the clock. A permanently banned account (no expiry) is
   * refused instead: the suspension would replace that sentence with a
   * lapsing one, silently undoing a staff decision.
   */
  suspendUser: moderatorProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(suspensionInput)
    .handler(async ({ input, context }) => {
      // The effect commits the ban + session sweep + stamps + audit row,
      // then the user is emailed with the stored expiry.
      const { banExpires, pending } = await suspendUserEffect(context.db, {
        userId: input.userId,
        actorId: context.user.id,
        actorRole: context.user.role ?? "user",
        reason: input.reason,
        durationSeconds: input.durationSeconds,
      });
      await sendPendingEmails(context.db, context.headers, [pending], context.emailSender);
      return { userId: input.userId, suspended: true, banExpires };
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
      // The effect commits the ban + session sweep + stamps + audit row,
      // then the user is emailed.
      const { pending } = await banUserEffect(context.db, {
        userId: input.userId,
        actorId: context.user.id,
        actorRole: context.user.role ?? "user",
        reason: input.reason,
      });
      await sendPendingEmails(context.db, context.headers, [pending], context.emailSender);
      return { userId: input.userId, banned: true };
    }),

  /** Unbans or unsuspends a user — the code follows the expiry read (a clock running = suspension). */
  unbanUser: staffProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(z.object({ userId: z.string().min(1), note: noteInput }))
    .handler(async ({ input, context }) => {
      // The rank guard lives in `unbanEffect` (shared with the appeal
      // overturn), so no inverse path can skip it: lifting a sentence is as
      // restricted as imposing one. Strict by default — an account that
      // isn't banned is the caller-facing error; the appeal path passes
      // `tolerateNotBanned` instead.
      const pending = await unbanEffect(context.db, {
        userId: input.userId,
        actorId: context.user.id,
        actorRole: context.user.role ?? "user",
        note: input.note,
      });
      // The effect commits the clear + audit row, then the user is emailed
      // with the copy matching the sentence that was lifted.
      await sendPendingEmails(context.db, context.headers, pending, context.emailSender);
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

      // The effect commits the role write + audit row, then the user is
      // emailed.
      const { pending } = await setRoleEffect(context.db, {
        userId: input.userId,
        actorId: context.user.id,
        actorRole: context.user.role ?? "user",
        role: input.role,
      });
      await sendPendingEmails(context.db, context.headers, [pending], context.emailSender);
      return { userId: input.userId, role: input.role };
    }),

  /** The moderation team: every account holding a role, ranked then by name. */
  team: staffProcedure.use(rateLimit(RATE_LIMITS.moderate)).handler(async ({ context }) => {
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
      const selection = {
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
      };
      return keysetPage({
        codec: auditCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: moderationAction.createdAt,
        createdAtField: "createdAt",
        id: moderationAction.id,
        idField: "id",
        query: (cursorFilter) =>
          context.db
            .select(selection)
            .from(moderationAction)
            .leftJoin(actorTable, eq(actorTable.id, moderationAction.actorId))
            .leftJoin(targetUserTable, eq(targetUserTable.id, moderationAction.targetUserId))
            .where(cursorFilter)
            .orderBy(desc(moderationAction.createdAt), desc(moderationAction.id))
            .limit(input.limit + 1),
      });
    }),
};

/** Opaque keyset cursor for the audit log, tie-broken on the action id (uuid). */
const auditCursor = createCursorCodec(z.uuid());

/** The `user` table joined twice for the audit log's actor and target summaries. */
const actorTable = alias(user, "actor");
const targetUserTable = alias(user, "target_user");
