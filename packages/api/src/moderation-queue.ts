import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { moderationCaseResolutionEmail, type EmailLocale } from "@my-tuums/auth";
import type { Database } from "@my-tuums/db";
import { appeal, moderationAction, post, postEdit, report, user } from "@my-tuums/db/schema";
import { EDIT_HISTORY_CASE_LIMIT } from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { applyModerationEffect, logAction, stampReports } from "./moderation-actions.js";
import { noteInput, queueInput } from "./moderation-inputs.js";
import { moderatorProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { publicUserColumns } from "./users.js";
import { effectivelyBanned } from "./visibility.js";
import { postAttachmentsSelection, quotedPostEvidence, type PostAttachment } from "./posts.js";

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
   *
   * Each returned case carries a `preview` of its target — the reported
   * post's author and a bounded excerpt, or the reported account. Without it
   * a queue row is a target id and a count, which says how much is waiting
   * but nothing about which case to open first, so triage becomes "open every
   * case to find out". The previews are loaded for the page only, after the
   * merge and the slice (see `loadPreviews`).
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

      // The appeal half's case key and its group-by, shared by the grouped
      // CTE (both cursor branches) and the having clause's row comparison —
      // restating the coalesce inline in each spot is how drift would start.
      const appealCaseKey = sql`coalesce(${moderationAction.targetPostId}::text, ${moderationAction.targetUserId})`;
      const appealCaseGroupBy = sql`group by ${moderationAction.targetType}, ${appealCaseKey}`;

      const openAppeals = await context.db.execute<OpenAppealRow>(sql`
        with appeal_cases as (
          select ${moderationAction.targetType} as target_type,
                 coalesce(${moderationAction.targetPostId}::text, ${moderationAction.targetUserId}) as target_id,
                 max(${appeal.createdAt}) as newest_at
          from ${appeal}
          inner join ${moderationAction} on ${moderationAction.id} = ${appeal.actionId}
          where ${appeal.status} = 'open' ${appealSideExclusion}
          ${
            decoded
              ? sql`${appealCaseGroupBy}
                    having (max(${appeal.createdAt}), ${appealCaseKey}) < (${sql.param(decoded.createdAt, appeal.createdAt)}, ${sql.param(decoded.id, user.id)})`
              : appealCaseGroupBy
          }
          order by newest_at desc, target_id desc
          limit ${limit + 1}
        )
        select ${appeal.id} as id,
               ${appeal.reason} as reason,
               ${appeal.createdAt} as created_at,
               appeal_cases.target_type,
               appeal_cases.target_id
        from ${appeal}
        inner join ${moderationAction} on ${moderationAction.id} = ${appeal.actionId}
        inner join appeal_cases
          on appeal_cases.target_type = ${moderationAction.targetType}
         and appeal_cases.target_id = coalesce(${moderationAction.targetPostId}::text, ${moderationAction.targetUserId})
        where ${appeal.status} = 'open'
        order by appeal_cases.newest_at desc,
                 appeal_cases.target_id desc,
                 ${appeal.createdAt} desc,
                 ${appeal.id} desc
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
          appeals: [],
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
          appeals: [],
        };
        // Appended, never assigned: two open appeals against one target are
        // two people-waiting-on-a-reply, and overwriting dropped one of them
        // out of the queue entirely. The query orders by created_at desc, so
        // pushing preserves newest-first.
        entry.appeals.push({ id: open.id, reason: open.reason, createdAt });
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
      // Each side fetched `limit + 1` distinct target cases. The appeal side
      // then expands those cases back to every open appeal, so one target with
      // multiple appeals cannot consume the lookahead and hide an older case.
      const hasMore = sorted.length > limit;
      const items = sorted.slice(0, limit);
      const last = items.at(-1);
      // Previews are loaded for the PAGE, after the slice — two lookups
      // bounded by `limit`, not by however many cases the two merged sides
      // happened to return.
      const previews = await loadPreviews(context.db, items);
      return {
        items: items.map((item) => ({
          ...item,
          preview: previews.get(`${item.targetType}:${item.targetId}`) ?? null,
        })),
        nextCursor: hasMore && last ? caseCursor.encode(last.newestAt, last.targetId) : null,
      };
    }),

  /**
   * One moderation case: the target's full report history (resolved and not),
   * its open appeal if any, and a moderator projection of the target — raw
   * content for posts (tombstoned or not), account state for users. A post
   * target also carries its edit history (`post_edit`, newest first), so the
   * moderator sees every version the author published, not just the text that
   * currently stands.
   */
  case: moderatorProcedure
    .use(rateLimit(RATE_LIMITS.moderate))
    .input(targetInput)
    .handler(async ({ input, context }) => {
      const reports = await context.db
        .select({
          reporterId: report.reporterId,
          reason: report.reason,
          // What the reporter actually saw (issue #264) — the exact evidence
          // a report was raised against, immune to any later edit of the
          // post. Null on user-target reports.
          snapshotContent: report.snapshotContent,
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
      // Every open appeal against this target, newest first — not just one.
      // Two control families can be appealed at once (a ban and a role
      // change against the same account), and the reviewer needs to see and
      // answer both; taking the newest silently hid the other, which is how
      // an appeal could sit open forever with nobody able to reach it.
      const openAppeals = await context.db
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
        .orderBy(desc(appeal.createdAt), desc(appeal.id));

      const target =
        input.targetType === "post"
          ? await (async () => {
              const [targetPost] = await context.db
                .select({
                  id: post.id,
                  content: post.content,
                  createdAt: post.createdAt,
                  parentId: post.parentId,
                  // The quoted post a quote targets (issue #261): raw content
                  // regardless of tombstones, the same evidence rule as the
                  // target's own content and attachments above.
                  quotedPostId: post.quotedPostId,
                  quoted: quotedPostEvidence(),
                  removedAt: post.removedAt,
                  removedBy: post.removedBy,
                  removedReason: post.removedReason,
                  editedAt: post.editedAt,
                  attachments: postAttachmentsSelection(true),
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
              // Every superseded version of the text, newest first (issue
              // #264). Editing stays open while a case is pending; this
              // history is what lets the moderator judge what was written
              // before each edit — the current `content` above is only the
              // latest version. Capped at the newest EDIT_HISTORY_CASE_LIMIT
              // rows: an author's write budget still admits hundreds of
              // versions over time, and the report snapshots above carry
              // the load-bearing evidence beyond whatever the cap cuts.
              const editHistory = await context.db
                .select({ content: postEdit.content, createdAt: postEdit.createdAt })
                .from(postEdit)
                .where(eq(postEdit.postId, input.targetId))
                .orderBy(desc(postEdit.createdAt), desc(postEdit.id))
                .limit(EDIT_HISTORY_CASE_LIMIT + 1);
              const editHistoryTruncated = editHistory.length > EDIT_HISTORY_CASE_LIMIT;
              return {
                kind: "post" as const,
                ...targetPost,
                editHistory: editHistoryTruncated ? editHistory.slice(0, -1) : editHistory,
                editHistoryTruncated,
              };
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
        appeals: openAppeals,
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

/**
 * One merged queue case: reports and/or open appeals against a single target.
 *
 * `appeals` is a list, not one appeal. A target can carry open appeals from
 * two different control families at once — a ban appeal and a role-change
 * appeal are separate grievances against the same account, and superseding
 * one because of the other would close a complaint that still stands (see
 * `SUPERSEDING_FAMILY` in ./moderation-actions.ts). Keeping a single appeal
 * per case key silently hid whichever one the merge happened to overwrite,
 * so a moderator could never see it existed. Ordered newest first, matching
 * the query.
 */
type MergedCase = {
  targetType: "post" | "user";
  targetId: string;
  newestAt: Date;
  reportCount: number;
  reasons: string[];
  appeals: { id: string; reason: string; createdAt: Date }[];
};

/**
 * How much of a reported post a queue row carries, in characters.
 *
 * A triage decision needs enough text to recognise the post, not the post:
 * the full body is what `moderation.case` is for, one click away. The cap
 * also bounds the page — 50 cases of untruncated posts is 25 KB of body the
 * reader never sees, on a list that refetches whenever a moderator drains a
 * case.
 */
const QUEUE_EXCERPT_LENGTH = 140;

/**
 * Who a queue row is about: the reported post's author, or the reported
 * account itself.
 *
 * An explicit column list rather than `publicUserColumns`, and deliberately
 * narrower than it: a queue row renders an avatar and a name, so `bio`,
 * `bannerImage` and `createdAt` would be payload nobody reads. Widening this
 * to the public projection would also make it the second place a change to
 * that privacy boundary has to be reasoned about.
 */
type PreviewPerson = {
  id: string;
  name: string;
  username: string | null;
  displayUsername: string | null;
  image: string | null;
};

/**
 * What a queue row shows about its target beyond the report metadata.
 *
 * `null` when the target row is gone — `report.targetId` is plain text with
 * no foreign key, so a hard-deleted post or account leaves its reports
 * behind, and the queue must still render that case rather than 500 on it.
 */
type CasePreview =
  | {
      kind: "post";
      excerpt: string;
      /** Whether the excerpt was cut — the row renders the ellipsis, not this. */
      truncated: boolean;
      isReply: boolean;
      removed: boolean;
      author: PreviewPerson;
      /**
       * The post's attachments, moderator projection (tombstones included) —
       * for an image-only report (#202) the image is the whole substance of the
       * case, and an excerpt-only row hid it. Same selection `moderation.case`
       * returns, so the row and the open dialog agree.
       */
      attachments: PostAttachment[];
    }
  | {
      kind: "user";
      user: PreviewPerson;
      /** The effective ban (`visibility.ts`), so an expired sentence reads as clear. */
      banned: boolean;
      /** Set only for a timed suspension; `null` on a permanent ban. */
      banExpires: Date | null;
    };

/** The first `QUEUE_EXCERPT_LENGTH` characters of a post, split by code point. */
function excerptOf(content: string) {
  // Code points, not `slice`: cutting a UTF-16 string at a fixed index can
  // land between the halves of a surrogate pair and emit a lone one.
  const points = [...content];
  if (points.length <= QUEUE_EXCERPT_LENGTH) return { excerpt: content, truncated: false };
  return { excerpt: points.slice(0, QUEUE_EXCERPT_LENGTH).join(""), truncated: true };
}

/**
 * The page's previews, keyed `<targetType>:<targetId>`.
 *
 * Two `in`-list lookups, one per target kind, so a page costs two queries
 * whatever it holds. Neither goes through `src/visibility.ts`: this is the
 * moderator projection, the same one `moderation.case` returns — a removed
 * post and a banned account are exactly what a moderator is here to look at,
 * and filtering them would empty the queue of its own subject matter.
 */
async function loadPreviews(
  db: Database,
  cases: readonly MergedCase[],
): Promise<Map<string, CasePreview>> {
  const postIds = cases.filter((item) => item.targetType === "post").map((item) => item.targetId);
  const userIds = cases.filter((item) => item.targetType === "user").map((item) => item.targetId);
  const previews = new Map<string, CasePreview>();

  if (postIds.length > 0) {
    const rows = await db
      .select({
        id: post.id,
        content: post.content,
        parentId: post.parentId,
        removedAt: post.removedAt,
        // `true` for the moderator projection: a removed post's evidence is
        // exactly what a moderator is here to look at, and the row should agree
        // with the case dialog the same click opens.
        attachments: postAttachmentsSelection(true),
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
      .where(inArray(post.id, postIds));
    for (const row of rows) {
      previews.set(`post:${row.id}`, {
        kind: "post",
        ...excerptOf(row.content),
        isReply: row.parentId !== null,
        removed: row.removedAt !== null,
        attachments: row.attachments,
        author: row.author,
      });
    }
  }

  if (userIds.length > 0) {
    const rows = await db
      .select({
        id: user.id,
        name: user.name,
        username: user.username,
        displayUsername: user.displayUsername,
        image: user.image,
        banned: effectivelyBanned,
        banExpires: user.banExpires,
      })
      .from(user)
      .where(inArray(user.id, userIds));
    for (const row of rows) {
      previews.set(`user:${row.id}`, {
        kind: "user",
        user: {
          id: row.id,
          name: row.name,
          username: row.username,
          displayUsername: row.displayUsername,
          image: row.image,
        },
        banned: row.banned,
        banExpires: row.banExpires,
      });
    }
  }

  return previews;
}
