import { and, desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { moderationCaseResolutionEmail, type EmailLocale } from "@my-tuums/auth";
import { appeal, moderationAction, post, report, user } from "@my-tuums/db/schema";
import { createCursorCodec } from "./cursor.js";
import { applyModerationEffect, logAction, stampReports } from "./moderation-actions.js";
import { noteInput, queueInput } from "./moderation-inputs.js";
import { moderatorProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { publicUserColumns } from "./users.js";

/**
 * The moderator triage procedures: the merged queue, the case view, and
 * resolving a case without acting on the target. Every procedure is built
 * from the moderator gate plus the `moderate` rate tier.
 *
 * The queue is the one paginated list in this package that does NOT go
 * through `keysetPage` (./pagination.ts): it merges two bounded raw-SQL
 * queries in JS, so the skeleton's single-query shape does not fit. It still
 * follows the house rules the helper owns for the simple feeds — the +1
 * lookahead, the strict "<" cursor, and the last-returned anchor.
 */

/** Opaque keyset cursor for the merged queue, tie-broken on the case id (text). */
const caseCursor = createCursorCodec(z.string().min(1));

/** One group of unresolved reports, raw from the GROUP BY. */
// Raw `db.execute` rows carry postgres.js's own timestamptz string format
// (`2026-08-06 06:33:09.451822+00`), not a `Date` — drizzle's `select()`
// maps columns back to Date, raw SQL does not. The timestamp fields below
// are typed as what the driver actually returns, and the queue handler
// converts them at the row boundary.
type ReportGroupRow = {
  target_type: "post" | "user";
  target_id: string;
  newest_at: string;
  report_count: number;
  reasons: string[];
};

/** One open appeal, joined to its action's target. */
type OpenAppealRow = {
  id: string;
  reason: string;
  created_at: string;
  target_type: "post" | "user";
  target_id: string;
};

const targetInput = z.discriminatedUnion("targetType", [
  z.object({ targetType: z.literal("post"), targetId: z.uuid() }),
  z.object({ targetType: z.literal("user"), targetId: z.string().min(1) }),
]);

const resolveInput = z.discriminatedUnion("targetType", [
  z.object({
    targetType: z.literal("post"),
    targetId: z.uuid(),
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

export const queueRouter = {
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

      // A case's two halves sit on different timestamps, so each half's own
      // `< cursor` filter cannot see the OTHER half. When a dual case's
      // merged key is at or past the cursor (it was already shown) but one of
      // its halves is older than the cursor, that half would be re-admitted
      // and the case would reappear on the next page, missing the half it
      // already showed. Each side therefore also excludes targets whose
      // OTHER open half is at or past the cursor — the exact row-value test,
      // tie-break included, so a case tied with the cursor but ordered after
      // it (targetId desc) is never excluded before it was shown.
      const reportSideExclusion = decoded
        ? sql`and not exists (
               select 1
               from ${appeal}, ${moderationAction}
               where ${moderationAction.id} = ${appeal.actionId}
                 and ${appeal.status} = 'open'
                 and ${moderationAction.targetType} = ${report.targetType}
                 and coalesce(${moderationAction.targetPostId}::text, ${moderationAction.targetUserId}) = ${report.targetId}
                 and (${appeal.createdAt}, coalesce(${moderationAction.targetPostId}::text, ${moderationAction.targetUserId}))
                     >= (${sql.param(decoded.createdAt, appeal.createdAt)}, ${sql.param(decoded.id, report.targetId)})
             )`
        : sql``;
      const appealSideExclusion = decoded
        ? sql`and not exists (
               select 1
               from ${report}
               where ${report.resolvedAt} is null
                 and ${report.targetType} = ${moderationAction.targetType}
                 and ${report.targetId} = coalesce(${moderationAction.targetPostId}::text, ${moderationAction.targetUserId})
               group by ${report.targetType}, ${report.targetId}
               having (max(${report.createdAt}), ${report.targetId})
                   >= (${sql.param(decoded.createdAt, appeal.createdAt)}, ${sql.param(decoded.id, user.id)})
             )`
        : sql``;

      const reportGroups = await context.db.execute<ReportGroupRow>(sql`
        select ${report.targetType} as target_type,
               ${report.targetId} as target_id,
               max(${report.createdAt}) as newest_at,
               count(*)::int as report_count,
               array_agg(${report.reason}) as reasons
        from ${report}
        where ${report.resolvedAt} is null ${reportSideExclusion}
        group by ${report.targetType}, ${report.targetId}
        ${
          decoded
            ? sql`having (max(${report.createdAt}), ${report.targetId}) < (${sql.param(decoded.createdAt, report.createdAt)}, ${sql.param(decoded.id, report.targetId)})`
            : sql``
        }
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
        where ${appeal.status} = 'open' ${appealSideExclusion}
        ${
          decoded
            ? sql`and (${appeal.createdAt}, coalesce(${moderationAction.targetPostId}::text, ${moderationAction.targetUserId})) < (${sql.param(decoded.createdAt, appeal.createdAt)}, ${sql.param(decoded.id, user.id)})`
            : sql``
        }
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
          newestAt: new Date(group.newest_at),
          reportCount: group.report_count,
          reasons: [...new Set(group.reasons)],
          appeal: null,
        });
      }
      for (const open of openAppeals) {
        const key = `${open.target_type}:${open.target_id}`;
        // The driver's string is offset-qualified (`+00`), so `new Date` is
        // unambiguous — the merge must compare real instants, not strings.
        const createdAt = new Date(open.created_at);
        const entry: MergedCase = byKey.get(key) ?? {
          targetType: open.target_type,
          targetId: open.target_id,
          newestAt: createdAt,
          reportCount: 0,
          reasons: [],
          appeal: null,
        };
        entry.appeal = { id: open.id, reason: open.reason, createdAt };
        if (createdAt.getTime() > entry.newestAt.getTime()) entry.newestAt = createdAt;
        byKey.set(key, entry);
      }

      const sorted = [...byKey.values()].sort((a, b) => {
        const byTime = b.newestAt.getTime() - a.newestAt.getTime();
        if (byTime !== 0) return byTime;
        // Same newest instant: the case id breaks the tie, desc — matching
        // the per-side orderings so the merged order is the same total order.
        if (a.targetId < b.targetId) return 1;
        if (a.targetId > b.targetId) return -1;
        return 0;
      });
      // The anchor is the LAST case actually returned, with a strict "<"
      // cursor — the house rule `keysetPage` (./pagination.ts) owns for the
      // simple feeds. Anchoring on the first case past the page instead
      // would drop exactly that case at every boundary. The merged length
      // decides hasMore: each side fetched `limit + 1`, so a merged list
      // past the page proves another page exists.
      const hasMore = sorted.length > limit;
      const items = sorted.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last ? caseCursor.encode(last.newestAt, last.targetId) : null,
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
        .select({
          id: appeal.id,
          reason: appeal.reason,
          createdAt: appeal.createdAt,
          status: appeal.status,
        })
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
      // The report stamps and the `case_resolved` audit row commit together:
      // if the log insert failed after the stamps, the case would read as
      // resolved with no trail of who resolved it — and the reporters were
      // already stamped, so a retry would email nobody. The reporters' emails
      // go out after the commit through `applyModerationEffect`, the same
      // "mail after the transaction" rule every other moderation action
      // follows.
      //
      // Zero stamped reports makes the whole thing a no-op that would only
      // write a misleading `case_resolved` row (`reporterCount: 0`) — the
      // queue's appeal-only cases reach this otherwise (issue #59) — so it
      // is refused inside the transaction, audit row and all.
      const resolved = await applyModerationEffect(context, async (db) => {
        const stamped = await stampReports(db, {
          targetType: input.targetType,
          targetId: input.targetId,
          outcome: input.outcome,
          resolvedBy: context.user.id,
          note: input.note,
        });
        if (stamped.reporterIds.length === 0) {
          throw new ORPCError("BAD_REQUEST", {
            message: "This case has no open reports to resolve.",
          });
        }
        await logAction(db, {
          action: "case_resolved",
          actorId: context.user.id,
          targetType: input.targetType,
          targetPostId: input.targetType === "post" ? input.targetId : undefined,
          targetUserId: input.targetType === "user" ? input.targetId : undefined,
          note: input.note,
          details: { outcome: input.outcome, reporterCount: stamped.reporterIds.length },
        });
        return {
          result: stamped.reporterIds.length,
          pending: stamped.reporterIds.map((reporterId) => ({
            userId: reporterId,
            build: (locale: EmailLocale) =>
              moderationCaseResolutionEmail({ outcome: input.outcome, note: input.note }, locale),
          })),
        };
      });
      return {
        targetType: input.targetType,
        targetId: input.targetId,
        resolved,
      };
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
