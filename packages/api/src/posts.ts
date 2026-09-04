import { ORPCError } from "@orpc/server";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import type { Database } from "@my-tuums/db";
import {
  follow,
  post,
  postAttachment,
  postBookmark,
  postEdit,
  postLike,
  postRepost,
  user,
  userBlock,
} from "@my-tuums/db/schema";
import { z } from "zod";
import { postLikeBadgeTierFor, POST_LIKE_BADGE_TIERS } from "./badges.js";
import { stampBadgeTier } from "./badge-stamping.js";
import {
  POST_MAX_LENGTH,
  POST_ATTACHMENT_MAX_BYTES,
  POST_ATTACHMENT_MAX_COUNT,
  POST_ATTACHMENT_MAX_TOTAL_BYTES,
  POST_PAGE_SIZE,
  POST_PAGE_SIZE_MAX,
  CURSOR_MAX_ENCODED_LENGTH,
  THREAD_ANCESTOR_MAX,
  THREAD_REPLY_BRANCH_INITIAL_SIZE,
  THREAD_REPLY_BRANCH_MAX_DEPTH,
  THREAD_REPLY_BRANCH_CHILD_FANOUT,
  THREAD_REPLY_BRANCH_DESCENDANT_BUDGET,
  LINK_CARD_URL_MAX_LENGTH,
} from "./constants.js";
import { createCursorCodec, createEventCursorCodec } from "./cursor.js";
import { resolveLinkCard } from "./link-card.js";
import { insertNotification } from "./notifications.js";
import { keysetPage } from "./pagination.js";
import { acquirePostMediaLifecycleLock } from "./post-media-lock.js";
import {
  protectedProcedure,
  publicRateLimit,
  publicReadProcedure,
  rateLimit,
} from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { runSql } from "./sql.js";
import { invisibleAuthor, visibleUser } from "./visibility.js";
import { acceptPostImage, type ImageRejection } from "./post-image.js";
import {
  discardPostAttachments,
  cleanupDeletedPostAttachments,
  outerPost,
  postAttachmentRows,
  postAttachments,
  preparePostAttachments,
  writePostAttachments,
  type PostAttachment,
  type PostAttachmentInput,
} from "./post-media.js";
import { requireStorage } from "./profile-media.js";
import { selectReplyBranch, type ReplyBranchNode } from "./reply-branch.js";

/**
 * Feeds are keyset-paginated on `(post.created_at, post.id) DESC`; see
 * ./cursor.ts for why, and for the encoding. `post.id` is a uuid, so a cursor
 * minted here won't validate anywhere else.
 */
const postCursor = createCursorCodec(z.uuid());

/**
 * The merged home-feed cursor (issue #261). The timeline a feed walks is a
 * union of two event kinds — an authored post at its own `created_at`, a
 * repost amplifying the original at the repost's `created_at` — so the
 * stopping point names both the post and, for a repost event, the reposter.
 * The reposter half is absent for authored-post events; the SQL comparison
 * binds that absence as `''` (the smallest text value), keeping the
 * `(event_at, post_id, reposter_key)` comparison a total order.
 */
const postFeedCursor = createEventCursorCodec(z.uuid());

/**
 * Like counts are derived on read rather than denormalised onto a
 * `post.like_count` column. A correlated count over the `post_like` primary
 * key is cheap at this scale, and it can't drift out of sync the way a
 * counter maintained by the application can. If it ever shows up in a slow
 * query log, a stored counter can replace this without changing the shape
 * the API returns.
 */
const likeCount = sql<number>`(
  select count(*)::int from ${postLike} where ${postLike.postId} = ${post.id}
)`;

/**
 * Derived exactly like `likeCount` above, over the `post_repost` primary key:
 * cheap at this scale, and it cannot drift out of sync the way a maintained
 * counter can. A repost is an event about the post, so the count belongs to
 * the post, not to any one feed it appears in.
 */
const repostCount = sql<number>`(
  select count(*)::int from ${postRepost} where ${postRepost.postId} = ${post.id}
)`;

/**
 * Derived the same way — and for the same reasons — as `likeCount` above.
 *
 * The subquery needs its own alias for the table it is already inside, hence
 * `as reply`: without it `parent_id = id` would compare the outer row to
 * itself and count every post whose parent is its own id, i.e. nothing.
 *
 * Author-deleted replies are excluded so the count matches the reply feed,
 * which filters them out (see the `isNull(post.deletedAt)` filter below). A
 * deleted reply would otherwise leave a permanent "1 reply" header above an
 * empty list. Moderator-removed replies are still counted: removal is not
 * invisibility, and their tombstone cards stay in the thread.
 */
const replyCount = sql<number>`(
  select count(*)::int from ${post} as reply
  where reply.parent_id = ${post.id} and reply.deleted_at is null
)`;

/**
 * The compact context shown above a reply in a feed. This deliberately keeps
 * the parent as an additive field on the shared post projection: every feed
 * and thread reader gets the same visibility and tombstone semantics without
 * a second request per reply.
 */
type ParentPreview = {
  id: string;
  excerpt: string | null;
  truncated: boolean;
  removed: boolean;
  author: {
    id: string;
    name: string | null;
    username: string | null;
    displayUsername: string | null;
    image: string | null;
  };
};

/** Keep the profile-feed context compact even when the parent is a full post. */
const PARENT_EXCERPT_LENGTH = 140;

/** The parent tables are aliased because `postSelection` already reads `post`/`user`. */
const parentPost = alias(post, "parent_post");
const parentAuthor = alias(user, "parent_author");

/** Same reason as the parent aliases: the quoted preview is correlated inside `postSelection`. */
const quotedPostTable = alias(post, "quoted_post");
const quotedAuthor = alias(user, "quoted_author");

const POST_IMAGE_REJECTIONS = {
  type: "That image format isn't supported. Use a PNG, JPEG, WebP or GIF.",
  size: "That image is too large.",
  content: "That file doesn't look like an image.",
} satisfies Record<ImageRejection, string>;

function rejectPostImage(reason: ImageRejection): never {
  throw new ORPCError("BAD_REQUEST", { message: POST_IMAGE_REJECTIONS[reason] });
}

/** Reads and validates the files before any object is written. */
async function readPostAttachments(files: readonly File[]): Promise<PostAttachmentInput[]> {
  let declaredTotal = 0;
  for (const file of files) {
    if (
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > POST_ATTACHMENT_MAX_BYTES
    ) {
      rejectPostImage("size");
    }
    declaredTotal += file.size;
    if (declaredTotal > POST_ATTACHMENT_MAX_TOTAL_BYTES) rejectPostImage("size");
  }

  const attachments: PostAttachmentInput[] = [];
  let actualTotal = 0;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // File.size is a declared multipart value at the procedure boundary; the
    // bytes read from the stream are the authority for storage accounting.
    if (bytes.byteLength !== file.size) rejectPostImage("size");
    actualTotal += bytes.byteLength;
    if (actualTotal > POST_ATTACHMENT_MAX_TOTAL_BYTES) rejectPostImage("size");

    const verdict = acceptPostImage(bytes, file.type);
    if (
      !verdict.ok ||
      !verdict.type ||
      verdict.width === undefined ||
      verdict.height === undefined
    ) {
      rejectPostImage(verdict.reason ?? "content");
    }
    attachments.push({
      bytes,
      type: verdict.type,
      width: verdict.width,
      height: verdict.height,
    });
  }
  return attachments;
}

/**
 * Immediate-parent preview for a reply. A correlated JSON projection keeps
 * this in one round trip while allowing the outer query to keep its existing
 * joins and keyset shape. Hidden parents produce null (rather than leaking
 * their identity/content); removed parents remain present as appeal/context
 * stubs, while author-deleted parents disappear like every other fresh feed
 * rendering.
 */
function parentPreview(viewerId: string | null) {
  return sql<ParentPreview | null>`(
    select jsonb_build_object(
      'id', ${parentPost.id},
      'excerpt', case
        when ${parentPost.removedAt} is not null then null
        else left(${parentPost.content}, ${PARENT_EXCERPT_LENGTH})
      end,
      'truncated', case
        when ${parentPost.removedAt} is not null then false
        else char_length(${parentPost.content}) > ${PARENT_EXCERPT_LENGTH}
      end,
      'removed', ${parentPost.removedAt} is not null,
      'author', jsonb_build_object(
        'id', ${parentAuthor.id},
        'name', ${parentAuthor.name},
        'username', ${parentAuthor.username},
        'displayUsername', ${parentAuthor.displayUsername},
        'image', ${parentAuthor.image}
      )
    )
    from ${post} as "parent_post"
    inner join ${user} as "parent_author" on ${parentAuthor.id} = ${parentPost.authorId}
    where ${parentPost.id} = ${post.parentId}
      and ${parentPost.deletedAt} is null
      and not (
        (
          ${parentAuthor.banned}
          and (${parentAuthor.banExpires} is null or ${parentAuthor.banExpires} > now())
        )
        or exists (
          select 1 from ${userBlock}
          where ${userBlock.blockerId} = ${parentPost.authorId}
            and ${userBlock.blockedId} = ${viewerId}
        )
        or exists (
          select 1 from ${userBlock}
          where ${userBlock.blockerId} = ${viewerId}
            and ${userBlock.blockedId} = ${parentPost.authorId}
        )
      )
    limit 1
  )`;
}

/** Whether the viewer has liked this post — an EXISTS subquery. */
function viewerHasLiked(viewerId: string | null) {
  return sql<boolean>`exists (
    select 1 from ${postLike}
    where ${postLike.postId} = ${post.id} and ${postLike.userId} = ${viewerId}
  )`;
}

/** Whether the viewer has reposted this post — the same shape as `viewerHasLiked`. */
function viewerHasReposted(viewerId: string | null) {
  return sql<boolean>`exists (
    select 1 from ${postRepost}
    where ${postRepost.postId} = ${post.id} and ${postRepost.userId} = ${viewerId}
  )`;
}

/** The embedded quoted post a quote renders inside itself (issue #261). */
export type QuotedPostPreview = {
  id: string;
  content: string | null;
  removed: boolean;
  deleted: boolean;
  removedReason: string | null;
  attachments: PostAttachment[];
  author: {
    id: string;
    name: string | null;
    username: string | null;
    displayUsername: string | null;
    image: string | null;
  };
};

/**
 * The quoted post, embedded as a correlated projection so every surface that
 * reads a post through `postSelection` renders the same quote card — feed,
 * permalink, thread, search — without a second request per row.
 *
 * Degradation is the point (issue #261, "decided and documented"):
 *
 * - Removed or author-deleted original: the row stays and the flags say which
 *   stub to render. The quote's own text is the quoting post's; it survives.
 *   `removedReason` follows the same author-only rule as the outer post's.
 * - Banned or blocked original author: the whole subquery yields null, so the
 *   card reads "unavailable" — the same treatment `parentPreview` gives a
 *   hidden parent, leaking neither the author's identity nor the content.
 *   Unlike a deleted parent, a deleted *quoted* post is still projected:
 *   hiding it would take the quoting post's own words hostage to someone
 *   else's delete.
 * - Attachments ride along except under either tombstone, matching the outer
 *   post's `postAttachments` (a removed original keeps its rows for restore,
 *   but they must not render).
 */
function quotedPreview(viewerId: string | null) {
  return sql<QuotedPostPreview | null>`(
    select jsonb_build_object(
      'id', ${quotedPostTable.id},
      'content', case
        when ${quotedPostTable.removedAt} is not null or ${quotedPostTable.deletedAt} is not null then null
        else ${quotedPostTable.content}
      end,
      'removed', ${quotedPostTable.removedAt} is not null,
      'deleted', ${quotedPostTable.deletedAt} is not null,
      'removedReason', case
        when ${quotedPostTable.removedAt} is not null and ${quotedPostTable.authorId} = ${viewerId}
        then ${quotedPostTable.removedReason}
        else null
      end,
      'attachments', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', ${postAttachment.id},
            'url', ${postAttachment.mediaPath},
            'position', ${postAttachment.position},
            'contentType', ${postAttachment.contentType},
            'byteSize', ${postAttachment.byteSize},
            'width', ${postAttachment.width},
            'height', ${postAttachment.height}
          ) order by ${postAttachment.position}
        )
        from ${postAttachment}
        where ${postAttachment.postId} = ${quotedPostTable.id}
          and ${quotedPostTable.removedAt} is null
          and ${quotedPostTable.deletedAt} is null
      ), '[]'::jsonb),
      'author', jsonb_build_object(
        'id', ${quotedAuthor.id},
        'name', ${quotedAuthor.name},
        'username', ${quotedAuthor.username},
        'displayUsername', ${quotedAuthor.displayUsername},
        'image', ${quotedAuthor.image}
      )
    )
    from ${post} as "quoted_post"
    inner join ${user} as "quoted_author" on ${quotedAuthor.id} = ${quotedPostTable.authorId}
    where ${quotedPostTable.id} = ${outerPost("quoted_post_id")}
      and not (
        (
          ${quotedAuthor.banned}
          and (${quotedAuthor.banExpires} is null or ${quotedAuthor.banExpires} > now())
        )
        or exists (
          select 1 from ${userBlock}
          where ${userBlock.blockerId} = ${quotedPostTable.authorId}
            and ${userBlock.blockedId} = ${viewerId}
        )
        or exists (
          select 1 from ${userBlock}
          where ${userBlock.blockerId} = ${viewerId}
            and ${userBlock.blockedId} = ${quotedPostTable.authorId}
        )
      )
    limit 1
  )`;
}

/**
 * The reposter a feed event attributes: who amplified the post, and when they
 * did (the event time the feed ordered the row by). A property of the *event*,
 * not the post — see `repostedBy` in `postSelection`.
 */
export type RepostAttribution = {
  id: string;
  name: string | null;
  username: string | null;
  displayUsername: string | null;
  image: string | null;
  repostedAt: Date;
};

/**
 * The moderator's view of a quoted post: raw content regardless of either
 * tombstone — the same evidence rule `moderation.case` applies to the target
 * post itself (`postAttachmentsSelection(true)`) — and no visibility filter,
 * because the case view is a staff surface that has to reach a banned or
 * blocked author's evidence. Null only when the quoted row no longer exists
 * (its author's account was hard-deleted).
 */
export function quotedPostEvidence() {
  return sql<QuotedPostPreview | null>`(
    select jsonb_build_object(
      'id', ${quotedPostTable.id},
      'content', ${quotedPostTable.content},
      'removed', ${quotedPostTable.removedAt} is not null,
      'deleted', ${quotedPostTable.deletedAt} is not null,
      'removedReason', ${quotedPostTable.removedReason},
      'attachments', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', ${postAttachment.id},
            'url', ${postAttachment.mediaPath},
            'position', ${postAttachment.position},
            'contentType', ${postAttachment.contentType},
            'byteSize', ${postAttachment.byteSize},
            'width', ${postAttachment.width},
            'height', ${postAttachment.height}
          ) order by ${postAttachment.position}
        )
        from ${postAttachment}
        where ${postAttachment.postId} = ${quotedPostTable.id}
      ), '[]'::jsonb),
      'author', jsonb_build_object(
        'id', ${quotedAuthor.id},
        'name', ${quotedAuthor.name},
        'username', ${quotedAuthor.username},
        'displayUsername', ${quotedAuthor.displayUsername},
        'image', ${quotedAuthor.image}
      )
    )
    from ${post} as "quoted_post"
    inner join ${user} as "quoted_author" on ${quotedAuthor.id} = ${quotedPostTable.authorId}
    where ${quotedPostTable.id} = ${outerPost("quoted_post_id")}
    limit 1
  )`;
}

/**
 * Whether the viewer has bookmarked this post — the bookmark pair's whole
 * read model. Bookmarks are private by construction (issue #262): no count is
 * derived from `post_bookmark`, no other reader exists, and this probe answers
 * for the caller alone.
 */
function viewerHasBookmarked(viewerId: string | null) {
  return sql<boolean>`exists (
    select 1 from ${postBookmark}
    where ${postBookmark.postId} = ${post.id} and ${postBookmark.userId} = ${viewerId}
  )`;
}

/**
 * The one projection every feed and thread reads posts through, so no view of
 * a post can drift from another's (an int test asserts the equality).
 */
export const postSelection = (viewerId: string | null) => ({
  id: post.id,
  // The tombstone projection (issue #38, widened by #148): a post that was
  // removed by a moderator OR deleted by its author keeps its row — neither
  // is a hard delete — but reads as null content here, which is what renders
  // the stub. `removedReason` is null for everyone but the author, so a
  // removed post can say why to the person it happened to and nothing to
  // anyone else. The moderation case view reads a separate raw-content
  // projection (moderator-gated), never this one.
  content: sql<
    string | null
  >`case when ${post.removedAt} is not null or ${post.deletedAt} is not null then null else ${post.content} end`,
  removed: sql<boolean>`${post.removedAt} is not null`,
  // Two flags rather than one, because the two tombstones mean different
  // things to the reader: a removal is a moderation action the author can
  // appeal, a deletion is the author's own doing and has nothing to appeal.
  // The stub copy differs accordingly (see `post-card.tsx`).
  deleted: sql<boolean>`${post.deletedAt} is not null`,
  removedReason: sql<
    string | null
  >`case when ${post.removedAt} is not null and ${post.authorId} = ${viewerId} then ${post.removedReason} else null end`,
  // Ordinary post readers filter hidden authors before this projection, so
  // their rows are always available. The merged feed can keep a visible
  // reposter's event while redacting its newly blocked original; that one
  // feed-only branch replaces this flag and every sensitive field below —
  // including a deliberately non-nullable sentinel `author` (see the
  // redaction in `feedEventPage`): read `unavailable` before ever reading
  // `author` off a feed item.
  unavailable: sql<boolean>`false`,
  createdAt: post.createdAt,
  // Null until the author edits the text (issue #264); carries the LAST edit
  // time, which is what the "Edited" marker renders. `createdAt` above stays
  // the original publication instant — an edit never re-ranks a feed.
  editedAt: post.editedAt,
  // Null for a top-level post. The web app reads it to decide whether a card
  // needs a "Replying to" line, so it belongs in the shared selection rather
  // than only in the thread payload.
  parentId: post.parentId,
  parent: parentPreview(viewerId),
  // The quote reference (issue #261): `quotedPostId` names the quoted post,
  // `quoted` is its embedded preview — full content and attachments, or the
  // tombstone flags, or null when the quoted author is hidden from this
  // viewer. A quote is a normal post everywhere else, which is why this lives
  // in the shared selection: every reader renders the same quote card.
  quotedPostId: post.quotedPostId,
  quoted: quotedPreview(viewerId),
  attachments: postAttachments,
  author: {
    id: user.id,
    name: user.name,
    username: user.username,
    displayUsername: user.displayUsername,
    image: user.image,
  },
  likeCount,
  replyCount,
  repostCount,
  viewerHasLiked: viewerHasLiked(viewerId),
  viewerHasReposted: viewerHasReposted(viewerId),
  viewerHasBookmarked: viewerHasBookmarked(viewerId),
  // Attribution is a property of a feed *event*, not of a post row: every
  // row-shaped reader (thread, search, reply list, this projection) reads a
  // post with no repost attached, and only the merged home feed — which reads
  // events — replaces it per item (see `post.list`). Typed as the full
  // nullable attribution so one item type covers both event kinds.
  repostedBy: sql<RepostAttribution | null>`null`,
});

type ReplyDescendant = ReplyBranchNode & { rootPostId: string };

interface ReplyContinuationPageArgs {
  db: Database;
  viewerId: string | null;
  focusedAuthorId: string;
  rootPostIds: readonly string[];
  limit: number;
  cursors?: ReadonlyMap<string, string>;
}

async function visiblePostAuthorId(
  db: Database,
  viewerId: string | null,
  postId: string,
): Promise<string | undefined> {
  const [visiblePost] = await db
    .select({ authorId: post.authorId })
    .from(post)
    .innerJoin(user, eq(user.id, post.authorId))
    .where(and(eq(post.id, postId), not(invisibleAuthor(viewerId))))
    .limit(1);

  return visiblePost?.authorId;
}

/**
 * Builds one bounded, deterministic continuation page for each direct reply.
 * The recursive query collects only tree identity; every caller-visible row
 * is selected afterwards through `postSelection` and the ordinary visibility
 * filter, preserving attachments, tombstones and viewer-relative like state.
 *
 * The descendant scan is bounded three ways so a user-shaped tree can never
 * turn a permalink into a forest scan: each fork expands only its oldest
 * `THREAD_REPLY_BRANCH_CHILD_FANOUT` children (the candidates the branch rule
 * walks), recursion stops at `THREAD_REPLY_BRANCH_MAX_DEPTH`, and the total
 * output is capped at `THREAD_REPLY_BRANCH_DESCENDANT_BUDGET` rows — which
 * also bounds the parameter list of the metadata lookup below.
 */
async function replyContinuationPages(args: ReplyContinuationPageArgs) {
  if (args.rootPostIds.length === 0) return [];

  const rootsValues = sql.join(
    args.rootPostIds.map((id) => sql`(${sql.param(id, post.id)}::uuid)`),
    sql`, `,
  );
  const descendantIds = await runSql<{ id: string; root_id: string }>(
    args.db,
    sql`
    with recursive roots(root_id) as (
      values ${rootsValues}
    ),
    descendants as (
      select child.id, child.parent_id, roots.root_id, 1 as depth
      from roots
      join lateral (
        select id, parent_id
        from ${post}
        where parent_id = roots.root_id
        order by created_at asc, id asc
        limit ${THREAD_REPLY_BRANCH_CHILD_FANOUT}
      ) as child on true
      union all
      select child.id, child.parent_id, descendants.root_id, descendants.depth + 1
      from descendants
      join lateral (
        select id, parent_id
        from ${post}
        where parent_id = descendants.id
        order by created_at asc, id asc
        limit ${THREAD_REPLY_BRANCH_CHILD_FANOUT}
      ) as child on true
      where descendants.depth < ${THREAD_REPLY_BRANCH_MAX_DEPTH}
    )
    select id, root_id from descendants
    limit ${THREAD_REPLY_BRANCH_DESCENDANT_BUDGET}
  `,
  );

  if (descendantIds.length === 0) return [];

  const metadataRows = await args.db
    .select({
      id: post.id,
      parentId: post.parentId,
      authorId: post.authorId,
      createdAt: post.createdAt,
    })
    .from(post)
    .where(
      inArray(
        post.id,
        descendantIds.map((row) => row.id),
      ),
    );
  const rootByPostId = new Map(descendantIds.map((row) => [row.id, row.root_id]));
  const descendantsByRoot = new Map<string, ReplyDescendant[]>();

  for (const row of metadataRows) {
    const rootPostId = rootByPostId.get(row.id);
    if (!rootPostId || !row.parentId) continue;
    const descendants = descendantsByRoot.get(rootPostId) ?? [];
    descendants.push({ ...row, parentId: row.parentId, rootPostId });
    descendantsByRoot.set(rootPostId, descendants);
  }

  const branchByRoot = new Map(
    args.rootPostIds.map((rootPostId) => [
      rootPostId,
      selectReplyBranch(rootPostId, args.focusedAuthorId, descendantsByRoot.get(rootPostId) ?? []),
    ]),
  );
  const selectedIds = [...branchByRoot.values()].flatMap((branch) => branch.map((row) => row.id));
  if (selectedIds.length === 0) return [];

  const visibleRows = await args.db
    .select(postSelection(args.viewerId))
    .from(post)
    .innerJoin(user, eq(user.id, post.authorId))
    .where(and(inArray(post.id, selectedIds), not(invisibleAuthor(args.viewerId))));
  const visibleById = new Map(visibleRows.map((row) => [row.id, row]));

  return args.rootPostIds.flatMap((rootPostId) => {
    const branch = branchByRoot.get(rootPostId) ?? [];
    if (branch.length === 0) return [];

    const rawCursor = args.cursors?.get(rootPostId);
    let start = 0;
    if (rawCursor) {
      const cursor = postCursor.decode(rawCursor);
      const cursorIndex = branch.findIndex((row) => row.id === cursor.id);
      const cursorPost = branch[cursorIndex];
      if (!cursorPost || cursorPost.createdAt.getTime() !== cursor.createdAt.getTime()) {
        throw new ORPCError("BAD_REQUEST", { message: "Malformed pagination cursor." });
      }
      start = cursorIndex + 1;
    }

    const visibleBranch = branch
      .slice(start)
      .map((row) => visibleById.get(row.id))
      .filter((row) => row !== undefined);
    const hasMore = visibleBranch.length > args.limit;
    const items = hasMore ? visibleBranch.slice(0, args.limit) : visibleBranch;
    const last = items.at(-1);

    return [
      {
        rootPostId,
        items,
        nextCursor: hasMore && last ? postCursor.encode(last.createdAt, last.id) : null,
      },
    ];
  });
}

/** The repost arm of the merged feed joins the original post and two users, so all three need aliases. */
const feedOriginal = alias(post, "feed_original");
const feedReposter = alias(user, "feed_reposter");
const feedOriginalAuthor = alias(user, "feed_original_author");

/** The three columns the per-alias visibility predicate reads — any `alias(user, …)` provides them. */
type UserVisibilityColumns = { id: PgColumn; banned: PgColumn; banExpires: PgColumn };

/**
 * The block/ban visibility half of `invisibleAuthor` (./visibility.ts),
 * restated over an aliased `user` row because the repost arm of the merged
 * feed has two of them (the reposter and the original's author) and the
 * shared helper is bound to the un-aliased table. Must stay in step with it.
 */
function aliasVisibleTo(viewerId: string | null, u: UserVisibilityColumns) {
  return sql<boolean>`not (
    (${u.banned} and (${u.banExpires} is null or ${u.banExpires} > now()))
    or exists (
      select 1 from ${userBlock}
      where ${userBlock.blockerId} = ${u.id} and ${userBlock.blockedId} = ${viewerId}
    )
    or exists (
      select 1 from ${userBlock}
      where ${userBlock.blockerId} = ${viewerId} and ${userBlock.blockedId} = ${u.id}
    )
  )`;
}

/** One row of the merged event timeline the home feeds walk (raw keys, as selected). */
type FeedEventRow = {
  /**
   * `db.execute` hands back the driver's value for a timestamptz — a string,
   * unlike the drizzle-mapped `Date` a built query returns — so it is parsed
   * once, right after the fetch.
   */
  event_at: Date | string;
  post_id: string;
  /** Null for an authored-post event; the reposter's id for a repost event. */
  reposter_id: string | null;
  /** The reposter's id again, `''` for authored-post events — the cursor's third key. */
  reposter_key: string;
};

/**
 * The event-union half of the merged feed timeline: authored posts at their
 * own `created_at`, repost events amplifying the original at the repost's
 * `created_at` (issue #261 — a repost places the original at the repost's
 * timestamp; strictly reverse-chronological, no ranking, no deduplication).
 *
 * The two arms are separate scopes, each with its own FROM, so the un-aliased
 * `post`/`user` references in the authored arm coexist with the aliases in
 * the repost arm. Degradation rules, decided with the issue:
 *
 * - A repost whose original was author-deleted or moderator-removed STAYS —
 *   the event renders the same stub the post itself would, because the
 *   repost is the reposter's event, not the original author's. (Authored
 *   posts with an author-delete tombstone drop from feeds, as before.)
 * - A repost whose original author is banned or blocked — either direction —
 *   keeps the reposter's event but redacts the original to the unavailable
 *   treatment: no identity, content, media, counts or viewer interactions.
 * - The repost arm runs for the home feeds, and for a profile feed
 *   (`authorId`) that opts in through `includeReposts` — scoped there to
 *   the profile's own amplifications (`post_repost.user_id`), mirroring the
 *   authored arm's author filter: a profile carries the events its owner
 *   caused, never other people's reposts of the owner's posts. The
 *   `kind: "replies"` axis runs no arm at all: it selects reply rows, not
 *   amplification events. Under `kind: "posts"` the arm also excludes
 *   reposts of replies (the original's `parentId` must be null): the tab is
 *   top-level only, the same rule the home feeds follow, and the web does
 *   not offer the repost control on replies rather than sell an action
 *   whose result never renders anywhere.
 */
async function feedEventPage(
  db: Database,
  args: {
    viewerId: string | null;
    cursor: string | undefined;
    limit: number;
    authorId?: string;
    feed: "global" | "following";
    kind: "posts" | "replies" | "all";
    includeReposts: boolean;
  },
) {
  const decoded = args.cursor ? postFeedCursor.decode(args.cursor) : undefined;
  // The absent reposter half of a post-event cursor binds as '' — the value
  // the authored arm emits for `reposter_key` — so one row-value comparison
  // serves both event kinds. Each bound is typed by the column that arm
  // selects into the key: the reposter half is the repost arm's `user_id`
  // (text, like every user id; the authored arm's '' literal is what makes
  // the union's column text), and the param encoder must be a text column —
  // a uuid one would reject the '' bound.
  const cursorFilter = decoded
    ? sql`(event_at, post_id, reposter_key) < (
        ${sql.param(decoded.createdAt, post.createdAt)},
        ${sql.param(decoded.first, post.id)},
        ${sql.param(decoded.second ?? "", postRepost.userId)}
      )`
    : undefined;

  const authoredArmFilters = [
    // Author-deleted posts drop from a fresh feed read, as before the merge.
    isNull(post.deletedAt),
    args.authorId ? eq(post.authorId, args.authorId) : undefined,
    args.kind === "posts"
      ? isNull(post.parentId)
      : args.kind === "replies"
        ? not(isNull(post.parentId))
        : undefined,
    // A semi-join rather than an INNER JOIN on `follow`: EXISTS cannot
    // duplicate a post row, and it composes as one more entry in this array.
    // Your own posts are included unconditionally — the composer sits
    // directly above this feed, and a post that appears to vanish on submit
    // reads as a bug. This walks post_created_idx newest-first and probes the
    // follow primary key per candidate.
    args.feed === "following"
      ? sql`(${post.authorId} = ${args.viewerId} or exists (
            select 1 from ${follow}
            where ${follow.followingId} = ${post.authorId} and ${follow.followerId} = ${args.viewerId}
          ))`
      : undefined,
    not(invisibleAuthor(args.viewerId)),
  ];

  const repostArmFilters = [
    // The reposter is the event's author: hidden reposter, hidden event. The
    // ORIGINAL author is deliberately not a filter — a hidden original keeps
    // the reposter's event and is redacted to the unavailable treatment below,
    // which is the same "the author is gone" result blocked profiles use.
    aliasVisibleTo(args.viewerId, feedReposter),
    // The profile feed's mirror of the authored arm's author filter: a
    // profile that opts into repost events carries the ones its owner
    // caused, never other people's amplifications of the owner's posts.
    args.authorId ? eq(postRepost.userId, args.authorId) : undefined,
    args.kind === "posts" ? isNull(feedOriginal.parentId) : undefined,
    args.feed === "following"
      ? sql`(${postRepost.userId} = ${args.viewerId} or exists (
            select 1 from ${follow}
            where ${follow.followingId} = ${postRepost.userId} and ${follow.followerId} = ${args.viewerId}
          ))`
      : undefined,
  ];

  // The arm drops for the reply axis (an amplification is not a reply) and
  // for a profile feed that has not opted in — every existing `authorId`
  // caller keeps the pre-#277 feed exactly.
  const repostArm =
    args.kind === "replies" || (args.authorId && !args.includeReposts)
      ? undefined
      : sql`
    select ${postRepost.createdAt} as event_at, ${postRepost.postId} as post_id, ${postRepost.userId} as reposter_id, ${postRepost.userId} as reposter_key
    from ${postRepost}
    inner join ${user} as "feed_reposter" on ${feedReposter.id} = ${postRepost.userId}
    inner join ${post} as "feed_original" on ${feedOriginal.id} = ${postRepost.postId}
    inner join ${user} as "feed_original_author" on ${feedOriginalAuthor.id} = ${feedOriginal.authorId}
    where ${and(...repostArmFilters)}
  `;

  // `new Date(iso)` round-trips exactly at precision 3 (the reason every
  // cursor column in the schema is ms, not µs — see the schema comment).
  const events = (
    await runSql<FeedEventRow>(
      db,
      sql`
      with events as (
        select ${post.createdAt} as event_at, ${post.id} as post_id, null::text as reposter_id, '' as reposter_key
        from ${post}
        inner join ${user} on ${user.id} = ${post.authorId}
        where ${and(...authoredArmFilters)}
        ${repostArm ? sql`union all ${repostArm}` : sql``}
      )
      select event_at, post_id, reposter_id, reposter_key from events
      ${cursorFilter ? sql`where ${cursorFilter}` : sql``}
      order by event_at desc, post_id desc, reposter_key desc
      limit ${args.limit + 1}
    `,
    )
  ).map((row) => ({ ...row, event_at: new Date(row.event_at) }));

  const hasMore = events.length > args.limit;
  const page = hasMore ? events.slice(0, args.limit) : events;
  const last = page.at(-1);
  if (page.length === 0 || !last) return { items: [], nextCursor: null };

  // The events are identity rows; the visible post rows come back through the
  // one shared projection, so a repost event renders the original exactly as
  // its own permalink would — tombstones included.
  const postRows = await db
    .select({
      ...postSelection(args.viewerId),
      // Re-evaluated in the projection phase, closing a block/ban race between
      // the event query and this read without throwing the reposter's event
      // away. Only repost events consume a hidden row; authored events below
      // still disappear exactly like every other feed surface.
      originalUnavailable: invisibleAuthor(args.viewerId),
    })
    .from(post)
    .innerJoin(user, eq(user.id, post.authorId))
    .where(inArray(post.id, [...new Set(page.map((event) => event.post_id))]));
  const rowById = new Map(postRows.map((row) => [row.id, row]));

  const reposterIds = [
    ...new Set(page.map((e) => e.reposter_id).filter((id): id is string => id !== null)),
  ];
  const reposters = reposterIds.length
    ? await db
        .select({
          id: user.id,
          name: user.name,
          username: user.username,
          displayUsername: user.displayUsername,
          image: user.image,
        })
        .from(user)
        .where(and(inArray(user.id, reposterIds), visibleUser(args.viewerId)))
    : [];
  const reposterById = new Map(reposters.map((rep) => [rep.id, rep]));

  type FeedItem = Omit<(typeof postRows)[number], "originalUnavailable">;
  const items: FeedItem[] = [];

  for (const event of page) {
    const row = rowById.get(event.post_id);
    // The row vanished between the two queries (a hard delete raced us):
    // drop the event rather than 500 on a missing row.
    if (!row) continue;
    const reposter = event.reposter_id ? reposterById.get(event.reposter_id) : undefined;
    if (event.reposter_id && !reposter) continue;

    const { originalUnavailable, ...visibleRow } = row;

    // An authored event with a newly hidden author disappears. A repost event
    // survives because its visible reposter still owns the event, but every
    // original field that can identify or expose the hidden author is replaced
    // with the existing unavailable treatment — no permalink, content, media,
    // counts or viewer actions cross the boundary.
    if (originalUnavailable) {
      if (!reposter) continue;
      items.push({
        ...visibleRow,
        content: null,
        removed: false,
        deleted: false,
        removedReason: null,
        unavailable: true,
        parentId: null,
        parent: null,
        quotedPostId: null,
        quoted: null,
        attachments: [],
        // The sentinel author: this row has no author the viewer may learn
        // anything about, and the post shape keeps `author` non-nullable —
        // widening it here would ripple through every web render to say
        // "unknown" in exactly one place. Consumers must guard every author
        // read on `unavailable` first (the web card does); the empty id,
        // empty name and null handle are placeholders, not a real user.
        author: { id: "", name: "", username: null, displayUsername: null, image: null },
        likeCount: 0,
        replyCount: 0,
        repostCount: 0,
        viewerHasLiked: false,
        viewerHasReposted: false,
        viewerHasBookmarked: false,
        repostedBy: { ...reposter, repostedAt: event.event_at },
      });
      continue;
    }

    items.push({
      ...visibleRow,
      repostedBy: reposter ? { ...reposter, repostedAt: event.event_at } : null,
    });
  }

  return {
    items,
    nextCursor:
      hasMore && last
        ? postFeedCursor.encode(last.event_at, last.post_id, last.reposter_id ?? undefined)
        : null,
  };
}

async function countLikes(db: Pick<Database, "select">, postId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(postLike)
    .where(eq(postLike.postId, postId));

  return row?.count ?? 0;
}

async function countReposts(db: Database, postId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(postRepost)
    .where(eq(postRepost.postId, postId));

  return row?.count ?? 0;
}

type CreatedPost = {
  id: string;
  content: string;
  createdAt: Date;
  parentId: string | null;
  quotedPostId: string | null;
};

/** Inserts the post and its already-prepared attachment rows atomically. */
async function insertPost(
  tx: Pick<Database, "insert">,
  args: {
    postId: string;
    authorId: string;
    content: string;
    parentId: string | undefined;
    quotedPostId: string | undefined;
    prepared: ReturnType<typeof preparePostAttachments>;
  },
): Promise<CreatedPost | undefined> {
  const [inserted] = await tx
    .insert(post)
    .values({
      id: args.postId,
      authorId: args.authorId,
      content: args.content,
      parentId: args.parentId ?? null,
      quotedPostId: args.quotedPostId ?? null,
    })
    .returning({
      id: post.id,
      content: post.content,
      createdAt: post.createdAt,
      parentId: post.parentId,
      quotedPostId: post.quotedPostId,
    });

  if (!inserted) return undefined;
  if (args.prepared.length > 0)
    await tx.insert(postAttachment).values(postAttachmentRows(args.prepared));
  return inserted;
}

/**
 * The text of a post, shared by `post.create` and `post.edit` (issue #264) so
 * the trim and the length bound have exactly one definition. Trimming first
 * is what keeps whitespace from persisting as fake content on either path.
 */
const postContentInput = z.string().trim().max(POST_MAX_LENGTH);

/**
 * `post.edit`'s two state refusals, thrown from the fast-path guard and again
 * under the row lock inside the transaction. Module constants because each
 * refusal is thrown from two places that must not drift; the literals are
 * shared byte-for-byte with the keys of `localizeEditPostError`
 * (apps/web/src/lib/edit-post-error.ts), so restating one anywhere else
 * renders the refusal untranslated.
 */
const EDIT_REMOVED_MESSAGE = "This post was removed by a moderator and can no longer be edited.";
const EDIT_DELETED_MESSAGE = "This post was deleted and can no longer be edited.";

/**
 * The `post` procedure group: create (posts, replies and quotes), edit,
 * delete, list, thread, like/unlike, repost/unrepost, bookmark/unbookmark.
 */
export const postRouter = {
  /**
   * Creates a post, or a reply when `parentId` is set. Requires a session.
   */
  create: protectedProcedure
    .use(rateLimit(RATE_LIMITS.write))
    .input(
      z
        .object({
          // The shared content field (see `postContentInput`): trim first so
          // whitespace never persists as fake content. An empty body is legal
          // only when at least one attachment rides along — the cross-field
          // rule below is what keeps a fully empty submission out.
          content: postContentInput,
          /** Omit for a top-level post; set to reply to an existing one. */
          parentId: z.uuid().optional(),
          /**
           * Set to quote an existing post (issue #261). A quote is a normal
           * post — every text/image rule above applies unchanged — plus this
           * reference. Quoting your own post is allowed; a quote may itself be
           * quoted. Mutually exclusive with `parentId`: a quote is a top-level
           * post form, and a row that was both would have to render two
           * embedded posts.
           */
          quotedPostId: z.uuid().optional(),
          /** The same ordered image capability is available to posts and replies. */
          attachments: z.array(z.file()).max(POST_ATTACHMENT_MAX_COUNT).default([]),
        })
        // The one invariant neither field can hold alone (issue #202): a post
        // must carry text, images, or both. Keeping `content` string-shaped
        // and non-null means every reader stays a plain string — no nullable
        // column, no null handling spread across the projections.
        .refine(({ content, attachments }) => content.length > 0 || attachments.length > 0, {
          error: "Post cannot be empty.",
          path: ["content"],
        })
        .refine(({ parentId, quotedPostId }) => !(parentId && quotedPostId), {
          error: "A reply cannot also be a quote.",
          path: ["quotedPostId"],
        }),
    )
    .handler(async ({ input, context }) => {
      // The foreign key already rejects a parent that doesn't exist, but it
      // surfaces as an unexplained INTERNAL_SERVER_ERROR. Checking first is
      // the same courtesy `user.follow` pays for its CHECK constraint — the
      // constraint remains the invariant.
      //
      // The visibility filter is part of the same courtesy: a parent hidden
      // from you (banned author, a block either way) reads as nonexistent
      // rather than hinting it exists. A parent that was *removed* stays
      // replyable — removal is not invisibility, and a removed post is still
      // a real post with a thread. The quoted target below resolves through
      // exactly the same rule, for the same reasons: quoting a removed post
      // is allowed (the embedded card renders the removal stub), quoting one
      // whose author is hidden reads as "no such post".
      const resolveVisiblePost = async (postId: string) => {
        const [visible] = await context.db
          .select({ id: post.id, authorId: post.authorId })
          .from(post)
          .innerJoin(user, eq(user.id, post.authorId))
          .where(and(eq(post.id, postId), not(invisibleAuthor(context.user.id))))
          .limit(1);
        return visible;
      };

      // The reply's notification (below) needs the parent's author, so the
      // resolution selects `authorId` alongside `id`: one lookup keeps the
      // existence check and the notification recipient in step, instead of
      // re-reading the row inside the insert's transaction.
      const parent = input.parentId ? await resolveVisiblePost(input.parentId) : undefined;
      const parentAuthorId = parent?.authorId;
      if (input.parentId && !parent) {
        throw new ORPCError("NOT_FOUND", {
          message: "The post you replied to no longer exists.",
        });
      }

      // The quote's notification needs the quoted post's author for the same
      // reason the reply's needs the parent's, so this resolution keeps the
      // author too — one lookup serves the existence check and the recipient.
      const quoted = input.quotedPostId ? await resolveVisiblePost(input.quotedPostId) : undefined;
      const quotedAuthorId = quoted?.authorId;
      if (input.quotedPostId && !quoted) {
        throw new ORPCError("NOT_FOUND", {
          message: "The post you quoted no longer exists.",
        });
      }

      const mediaInputs = await readPostAttachments(input.attachments);
      const postId = randomUUID();
      const prepared = preparePostAttachments(context.user.id, postId, mediaInputs);
      const storage = prepared.length > 0 ? requireStorage(context) : null;

      let created: CreatedPost | undefined;
      try {
        created = await context.db.transaction(async (tx) => {
          if (storage) {
            // The reconciler takes this same lock around its list/read/delete
            // pass. Holding it until this transaction commits closes the
            // upload-before-row window without adding lifecycle state to the
            // attachment schema. Text-only posts skip the lock and storage
            // work entirely.
            await acquirePostMediaLifecycleLock(tx);
            try {
              await writePostAttachments(storage, prepared);
            } catch {
              // writePostAttachments already removes every attempted key,
              // including a provider PUT that failed after committing.
              throw new ORPCError("INTERNAL_SERVER_ERROR", {
                message: "Failed to store post images.",
              });
            }
          }

          const inserted = await insertPost(tx, {
            postId,
            authorId: context.user.id,
            content: input.content,
            parentId: input.parentId,
            quotedPostId: input.quotedPostId,
            prepared,
          });
          if (inserted && parentAuthorId) {
            // The reply's notification rides the insert's transaction: a
            // failure between the two leaves neither. The row points at the
            // reply itself (not the parent) — that is the thing the
            // recipient will click through to, and it is what makes the
            // notification tombstone with the reply when the author deletes
            // it, exactly like the reply's own feed presence.
            await insertNotification(tx, {
              recipientId: parentAuthorId,
              actorId: context.user.id,
              type: "reply",
              postId: inserted.id,
            });
          }
          if (inserted && quotedAuthorId) {
            // The quote's notification is the reply's shape exactly: same
            // transaction, and the row points at the quote itself — the
            // thing the recipient will click through to is what the quoter
            // said, not their own post back. A quote is a new post with no
            // natural idempotency key of its own, so its exactly-once is the
            // reply's too: the insert either commits (one post, one
            // notification) or it does not.
            await insertNotification(tx, {
              recipientId: quotedAuthorId,
              actorId: context.user.id,
              type: "quote",
              postId: inserted.id,
            });
          }
          return inserted;
        });
      } catch (error) {
        if (storage) await discardPostAttachments(storage, prepared);
        throw error;
      }

      if (!created) {
        if (storage) await discardPostAttachments(storage, prepared);
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to create post." });
      }

      return {
        ...created,
        // Matches the additive tombstone fields of `postSelection` — a fresh
        // post is neither removed nor deleted, so these are constants rather
        // than columns. The same goes for `editedAt`: a fresh post has never
        // been edited.
        removed: false,
        deleted: false,
        removedReason: null,
        editedAt: null,
        unavailable: false,
        author: {
          id: context.user.id,
          name: context.user.name,
          username: context.user.username ?? null,
          displayUsername: context.user.displayUsername ?? null,
          image: context.user.image ?? null,
        },
        likeCount: 0,
        replyCount: 0,
        repostCount: 0,
        viewerHasLiked: false,
        viewerHasReposted: false,
        viewerHasBookmarked: false,
        // `quoted` is deliberately absent, like `parent` above: the response
        // is not a render source (the web invalidates and refetches), and
        // resolving the embedded preview here would cost a query nothing
        // consumes.
        repostedBy: null,
        attachments: prepared.map(
          ({ id, mediaPath, position, contentType, byteSize, width, height }) => ({
            id,
            url: mediaPath,
            position,
            contentType,
            byteSize,
            width,
            height,
          }),
        ),
      };
    }),

  /**
   * Edits the text of the caller's own post or reply (issue #264). Requires a
   * session.
   *
   * Text-only for v1: attachments are not editable here. `content` is the one
   * field this procedure rewrites, through the same shared input field
   * (`postContentInput`) `post.create` validates with — the trim and the
   * length bound are not restated. The "text, images, or both" rule (issue
   * #202) IS re-checked, against the row's existing attachments rather than
   * an upload batch: clearing the text of a post that carries images is a
   * legal edit (it stays an image-only post), while emptying a text-only post
   * is refused with the same message `post.create` returns.
   *
   * The guards, in the order they refuse:
   * - FORBIDDEN — not the author. Ownership is the whole authorisation rule,
   *   same as `post.delete`.
   * - BAD_REQUEST — removed by a moderator. Mirrors the delete rule: editing
   *   on top of a removal would rewrite what the author was told the removal
   *   was about, and `moderation.appealPreview` hands the author back the
   *   removed post's own content — the removal rule is what keeps an appealed
   *   post's story from mutating under the appeal.
   * - BAD_REQUEST — deleted. A tombstoned post has no editable text left.
   * - BAD_REQUEST — empty content on a post with no attachments (the create
   *   cross-field rule, against server state).
   *
   * Editing deliberately stays OPEN while the post is under moderation review
   * (pinned choice, issue #264): rather than freezing the text, every edit
   * records the version it superseded in `post_edit`, and `moderation.case`
   * hands the moderator that history beside the current text. The evidence
   * is belt and braces: a report row snapshots the content it was raised
   * against (`report.snapshot_content`), and `post_edit` keeps every
   * version — a rewrite mid-case (or after a dismissal) can hide what was
   * written through neither. The moderator judges every version the author
   * published. The history is moderator-gated: no public surface exposes it.
   *
   * Idempotent, like `like`/`unlike` and `post.delete`: re-sending the content
   * the row already holds is a no-op that keeps the original `editedAt` rather
   * than restamping it (and records no history row), so a retry after a lost
   * response must not bump the marker.
   *
   * Unlike `post.delete`, the write IS a transaction that opens with a
   * `SELECT … FOR UPDATE` on the post row: the post row, its `editedAt`
   * marker and its history row must all agree, and — more than that — the
   * history row must record the text this edit *actually* superseded.
   * Concurrent editors serialize on the row lock, so no version can be lost
   * between two overlapping edits (an unlocked pair could record the same
   * superseded text twice and leave the first edit's wording surviving
   * nowhere). The unlocked compare-and-set `post.delete` uses is enough
   * there because a tombstone idempotently absorbs races; a version history
   * does not.
   *
   * `createdAt` never moves: feeds keyset on `(created_at, id)` and search
   * matches the raw `content` column, so the edited text is simply what
   * feeds, threads and search return from their next read — no re-ranking, no
   * bump in the chronological feed.
   */
  edit: protectedProcedure
    .use(rateLimit(RATE_LIMITS.write))
    .input(z.object({ postId: z.uuid(), content: postContentInput }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({
          authorId: post.authorId,
          content: post.content,
          removedAt: post.removedAt,
          deletedAt: post.deletedAt,
          editedAt: post.editedAt,
          // The attachment existence half of the cross-field rule. A count
          // rather than a read: only "is there at least one" decides whether
          // empty text is a legal edit. The outer id is table-qualified via
          // `outerPost` — this select has no join, so a bare `post.id` would
          // render unqualified and resolve against the inner scope
          // (post_attachment), matching nothing.
          attachmentCount: sql<number>`(
            select count(*)::int from ${postAttachment} where ${postAttachment.postId} = ${outerPost("id")}
          )`,
        })
        .from(post)
        .where(eq(post.id, input.postId))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      // FORBIDDEN rather than NOT_FOUND, same as `post.delete`: the post's
      // existence is not a secret, and "not yours" is the answer that explains
      // the refusal.
      if (target.authorId !== context.user.id) {
        throw new ORPCError("FORBIDDEN", { message: "You can only edit your own posts." });
      }

      if (target.removedAt) {
        throw new ORPCError("BAD_REQUEST", { message: EDIT_REMOVED_MESSAGE });
      }

      if (target.deletedAt) {
        throw new ORPCError("BAD_REQUEST", { message: EDIT_DELETED_MESSAGE });
      }

      if (input.content.length === 0 && target.attachmentCount === 0) {
        throw new ORPCError("BAD_REQUEST", { message: "Post cannot be empty." });
      }

      // The idempotent no-op: same content in, same row out. Crucially this
      // sits AFTER the guards — a removed or deleted post is refused even for
      // a content-equal retry, because the refusal is about the post's state,
      // not about this particular payload.
      if (target.content === input.content) {
        return { postId: input.postId, content: target.content, editedAt: target.editedAt };
      }

      const editedAt = new Date();
      const updated = await context.db.transaction(async (tx) => {
        // The authoritative read, under the row lock. Concurrent editors
        // serialize here, so the history row below records the text this
        // edit *actually* superseded — never the stale text the guard read
        // above may have seen. Without the lock, two overlapping edits both
        // record the same superseded text and the first edit's wording
        // survives nowhere (not in `content`, not in history) — the one
        // hole a mid-case rewrite could otherwise hide a version through.
        const [current] = await tx
          .select({
            content: post.content,
            editedAt: post.editedAt,
            removedAt: post.removedAt,
            deletedAt: post.deletedAt,
          })
          .from(post)
          .where(eq(post.id, input.postId))
          .for("update")
          .limit(1);
        if (!current) return undefined;

        // The guard above is a fast path; the state is re-checked under the
        // lock, where no moderator removal or delete can land between the
        // check and the write.
        if (current.removedAt) {
          throw new ORPCError("BAD_REQUEST", { message: EDIT_REMOVED_MESSAGE });
        }
        if (current.deletedAt) {
          throw new ORPCError("BAD_REQUEST", { message: EDIT_DELETED_MESSAGE });
        }

        // The idempotent no-op, re-checked under the lock: another edit may
        // have landed since the guard read, and if it wrote this same text
        // the retry is a no-op against *that* row — keeping its editedAt
        // and writing no history row.
        if (current.content === input.content) {
          return { content: current.content, editedAt: current.editedAt };
        }

        const [row] = await tx
          .update(post)
          .set({ content: input.content, editedAt })
          .where(eq(post.id, input.postId))
          .returning({ content: post.content, editedAt: post.editedAt });
        // The superseded text becomes history in the same transaction, stamped
        // with the same instant as the marker — the newest history row's
        // `createdAt` and the post's `editedAt` are the same edit.
        await tx
          .insert(postEdit)
          .values({ postId: input.postId, content: current.content, createdAt: editedAt });
        return row;
      });

      // A missing row cannot happen (the guard read found it and nothing
      // deletes post rows); the branch keeps the return honest if it ever did.
      if (!updated) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      return { postId: input.postId, content: updated.content, editedAt: updated.editedAt };
    }),

  /**
   * Deletes the caller's own post (issue #148). Requires a session.
   *
   * A tombstone, not a post-row delete: `deleted_at` is stamped and the post
   * row stays, so replies, likes and the conversation above it keep their
   * shape. Its non-restorable attachment rows/objects are cleaned after the
   * tombstone commits; moderation removal keeps its attachments for restore.
   * `post.parent_id` still cascades on a real delete (see the schema comment),
   * so that would silently take the whole reply subtree with it.
   *
   * It is deliberately NOT a moderation action: no `moderation_action` row,
   * no email, nothing to appeal. `postSelection` renders the stub, and
   * `search.posts` excludes the row outright — the one surface where matching
   * on text the viewer can no longer read would leak it back.
   *
   * The read-then-write is not locked. Instead, the update is a compare-and-set
   * against both tombstones. A racing author delete or moderator removal can
   * win the row first; a zero-row update re-reads that winner and returns the
   * original author tombstone or refuses the moderator tombstone. That is why
   * this needs neither the transaction nor the `FOR UPDATE` every moderation
   * effect takes: there is no audit row to double-write and no email to
   * double-send.
   */
  delete: protectedProcedure
    .use(rateLimit(RATE_LIMITS.write))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ authorId: post.authorId, removedAt: post.removedAt, deletedAt: post.deletedAt })
        .from(post)
        .where(eq(post.id, input.postId))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      // Ownership is the whole authorisation rule: moderators take posts down
      // through `moderation.removePost`, which is audited, appealable and
      // reversible. FORBIDDEN rather than NOT_FOUND because the post's
      // existence is not a secret — anyone who can see it in a feed already
      // knows — and "not yours" is the answer that explains the refusal.
      if (target.authorId !== context.user.id) {
        throw new ORPCError("FORBIDDEN", { message: "You can only delete your own posts." });
      }

      // A moderator got there first. Deleting on top would strip the stub of
      // the removal reason and the appeal link the author is owed, and gain
      // them nothing: the content is already hidden from everyone.
      if (target.removedAt) {
        throw new ORPCError("BAD_REQUEST", {
          message: "This post was removed by a moderator and can no longer be deleted.",
        });
      }

      // Idempotent, like `like`/`unlike`: repeating states the same end state,
      // so a double-click or a retry is a no-op that keeps the original
      // tombstone rather than restamping it.
      if (target.deletedAt) {
        await cleanupDeletedPostAttachments(context.db, context.storage, input.postId);
        return { postId: input.postId, deletedAt: target.deletedAt };
      }

      const [updated] = await context.db
        .update(post)
        .set({ deletedAt: new Date() })
        .where(and(eq(post.id, input.postId), isNull(post.removedAt), isNull(post.deletedAt)))
        .returning({ deletedAt: post.deletedAt });

      if (updated?.deletedAt) {
        await cleanupDeletedPostAttachments(context.db, context.storage, input.postId);
        return { postId: input.postId, deletedAt: updated.deletedAt };
      }

      // Another writer changed a tombstone after the guard read. PostgreSQL
      // re-evaluates this UPDATE's predicate after waiting on that writer, so
      // no returned row means the winner's committed state decides the result.
      const [winner] = await context.db
        .select({ removedAt: post.removedAt, deletedAt: post.deletedAt })
        .from(post)
        .where(eq(post.id, input.postId))
        .limit(1);

      if (winner?.removedAt) {
        throw new ORPCError("BAD_REQUEST", {
          message: "This post was removed by a moderator and can no longer be deleted.",
        });
      }

      if (winner?.deletedAt) {
        await cleanupDeletedPostAttachments(context.db, context.storage, input.postId);
        return { postId: input.postId, deletedAt: winner.deletedAt };
      }

      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to delete post." });
    }),

  /**
   * Lists posts, keyset-paginated: the global feed, one author's posts, the
   * following feed, the caller's bookmarks, one post's direct replies, or a
   * selected inline reply continuation.
   *
   * Session-optional since 0.4.0, for the public post permalink ONLY: an
   * anonymous caller may use the two reply modes (`parentId`,
   * `continuationRootId`) — the halves of a public thread page — and nothing
   * else. Every feed, profile, search or bookmarks mode still demands a
   * session exactly as before, enforced in the handler where the mode is
   * known rather than in middleware where it is not.
   */
  list: publicReadProcedure
    .use(publicRateLimit(RATE_LIMITS.read))
    .input(
      z
        .object({
          cursor: z.string().max(CURSOR_MAX_ENCODED_LENGTH).optional(),
          limit: z.number().int().min(1).max(POST_PAGE_SIZE_MAX).default(POST_PAGE_SIZE),
          /**
           * Omit for the global feed; set to scope the feed to one author.
           * Composes with `feed` as AND — "posts by X, if I follow X" — which is
           * coherent if degenerate. The UI never sends both.
           */
          authorId: z.string().optional(),
          /**
           * An enum rather than a boolean because this axis will grow (a ranked
           * "for you", lists), and each new value should be a widening here
           * rather than another orthogonal flag with undefined interactions.
           *
           * `bookmarks` (issue #262) is the caller's private saved list: it
           * selects posts joined to their own `post_bookmark` rows and pages
           * on the *bookmark's* creation time (see the handler branch), which
           * is why it cannot compose with the scoping filters below.
           */
          feed: z.enum(["global", "following", "bookmarks"]).default("global"),
          /**
           * Set to list one post's direct replies. This is deliberately a mode
           * of `list` rather than its own `post.replies` procedure: the web
           * app's optimistic like sweeps every cached `post.list` query by key
           * prefix (see apps/web/src/lib/post-cache.ts), so a separate
           * procedure would sit outside that sweep and likes on replies would
           * silently stop updating. Sharing the procedure means the reply list
           * inherits the cursor, the feed atom family, and the sweep.
           *
           * Composes with `authorId`/`feed` as AND — "replies to X, by someone
           * I follow" — which is coherent if degenerate. The UI never sends
           * both, same as `authorId` and `feed`.
           */
          parentId: z.uuid().optional(),
          /**
           * Continues the original-author branch beneath one direct reply. It
           * remains a `post.list` mode so continuation rows share the same query
           * prefix as feeds and direct replies for optimistic cache sweeps.
           */
          continuationRootId: z.uuid().optional(),
          /**
           * Replies are excluded by default, which is what keeps the home
           * timelines top-level only. A profile feed opts in, because a
           * person's profile is their whole activity.
           *
           * An explicit flag rather than inferring it from `authorId` keeps the
           * two axes independent — it is what a profile's "Both" view uses.
           */
          includeReplies: z.boolean().default(false),
          /**
           * Reposts stay out of a profile feed unless this is set — the same
           * opt-in shape `includeReplies` uses, so the two activity axes stay
           * independent and existing `authorId` callers keep their feed. The
           * home feeds carry repost events unconditionally (a home timeline IS
           * the merged event stream), so the flag is a no-op without
           * `authorId`. Under `kind: "replies"` the arm never runs — an
           * amplification is not a reply — the same precedence `kind` already
           * holds over `includeReplies`.
           */
          includeReposts: z.boolean().default(false),
          /**
           * The profile feed's three-way activity filter. `includeReplies` is
           * retained for existing clients and means `all` when true; `kind`
           * takes precedence when both are supplied. Keeping the legacy field
           * avoids changing existing query-key/input shapes during rollout.
           */
          kind: z.enum(["posts", "replies", "all"]).optional(),
        })
        .superRefine((input, refinement) => {
          if (
            input.continuationRootId &&
            (input.parentId ||
              input.authorId ||
              input.feed === "following" ||
              input.includeReplies ||
              input.includeReposts ||
              input.kind)
          ) {
            refinement.addIssue({
              code: "custom",
              message: "A continuation cannot be combined with feed filters.",
            });
          }
          if (
            input.feed === "bookmarks" &&
            (input.parentId ||
              input.authorId ||
              input.continuationRootId ||
              input.includeReplies ||
              input.includeReposts ||
              input.kind)
          ) {
            refinement.addIssue({
              code: "custom",
              message: "The bookmarks feed cannot be combined with scoping filters.",
            });
          }
        }),
    )
    .handler(async ({ input, context }) => {
      // The anonymous boundary: reply modes are the public thread page, every
      // other mode is a signed-in surface. Checked before any query runs so
      // the refusal costs nothing and reveals nothing.
      const anonymous = !context.user;
      if (anonymous && !input.parentId && !input.continuationRootId) {
        throw new ORPCError("UNAUTHORIZED");
      }
      const viewerId = context.user?.id ?? null;

      if (input.continuationRootId) {
        const [rootReply] = await context.db
          .select({ parentId: post.parentId })
          .from(post)
          .innerJoin(user, eq(user.id, post.authorId))
          .where(and(eq(post.id, input.continuationRootId), not(invisibleAuthor(viewerId))))
          .limit(1);
        if (!rootReply?.parentId) {
          throw new ORPCError("NOT_FOUND", { message: "Reply not found." });
        }

        const focusedAuthorId = await visiblePostAuthorId(context.db, viewerId, rootReply.parentId);
        if (!focusedAuthorId) {
          throw new ORPCError("NOT_FOUND", { message: "Post not found." });
        }

        const continuationArgs: ReplyContinuationPageArgs = {
          db: context.db,
          viewerId,
          focusedAuthorId,
          rootPostIds: [input.continuationRootId],
          limit: input.limit,
        };
        if (input.cursor) {
          continuationArgs.cursors = new Map([[input.continuationRootId, input.cursor]]);
        }
        const [continuation] = await replyContinuationPages(continuationArgs);

        return continuation
          ? { items: continuation.items, nextCursor: continuation.nextCursor }
          : { items: [], nextCursor: null };
      }

      // The caller's private bookmarks page (issue #262): posts joined to
      // their own bookmark rows, newest bookmark first, strictly
      // chronological. It rides `post.list` rather than being its own
      // procedure for the same reason the reply modes are: the web app's
      // optimistic like/deletion/moderation sweeps match every cached
      // `post.list` query by prefix, so a separate procedure would sit
      // outside them and toggles made on the bookmarks page would silently
      // stop updating.
      //
      // The keyset is on the *bookmark's* (created_at, post_id) — the page's
      // order is when the caller saved each post, not when the post was
      // written — which `post_bookmark_user_created_idx` mirrors exactly. The
      // selection therefore carries `bookmarkedAt`, so the cursor encodes the
      // row-side of the same pair the SQL compares.
      if (input.feed === "bookmarks") {
        // The caller's private saved list: unreachable for the anonymous
        // reader (the mode guard above refused them), restated here so the
        // keyset below binds a string, not a string | null.
        if (!viewerId) throw new ORPCError("UNAUTHORIZED");
        const bookmarkSelection = {
          ...postSelection(viewerId),
          bookmarkedAt: postBookmark.createdAt,
        };

        return keysetPage({
          codec: postCursor,
          cursor: input.cursor,
          limit: input.limit,
          selection: bookmarkSelection,
          createdAt: postBookmark.createdAt,
          createdAtField: "bookmarkedAt",
          id: post.id,
          idField: "id",
          fetchPage: (cursorFilter) =>
            context.db
              .select(bookmarkSelection)
              .from(post)
              .innerJoin(user, eq(user.id, post.authorId))
              .innerJoin(
                postBookmark,
                and(eq(postBookmark.postId, post.id), eq(postBookmark.userId, viewerId)),
              )
              .where(
                and(
                  // The same fresh-feed rules as every other mode: an
                  // author-deleted post is omitted entirely, a moderator
                  // removal keeps its stub (removal is not invisibility), and
                  // banned/blocked authors drop out through the visibility
                  // filter.
                  isNull(post.deletedAt),
                  not(invisibleAuthor(viewerId)),
                  cursorFilter,
                ),
              )
              .orderBy(desc(postBookmark.createdAt), desc(post.id))
              .limit(input.limit + 1),
        });
      }

      const kind = input.kind ?? (input.includeReplies ? "all" : "posts");

      // The home and profile feeds walk the merged event timeline
      // (`feedEventPage` above): authored posts, plus repost events — always
      // on the home feeds, and on a profile feed that opts in through
      // `includeReposts`. A reply list under one post stays a plain post
      // query — it lists the parent's direct replies by their own event time,
      // and an amplification is not a reply.
      if (!input.parentId) {
        return feedEventPage(context.db, {
          viewerId,
          cursor: input.cursor,
          limit: input.limit,
          authorId: input.authorId,
          feed: input.feed,
          kind,
          includeReposts: input.includeReposts,
        });
      }

      const filters = [
        // Author-deleted posts survive for direct thread URLs and ancestor
        // context, but a fresh feed/profile/reply-list read must not render a
        // tombstone card. Moderator removals deliberately remain visible.
        isNull(post.deletedAt),
        eq(post.parentId, input.parentId),
        input.authorId ? eq(post.authorId, input.authorId) : undefined,
        // The visibility filter (issue #38): posts by a banned author or by
        // someone blocked in either direction drop out of every feed. This
        // does NOT drop removed posts — removal is not invisibility.
        not(invisibleAuthor(viewerId)),
      ];

      // The cursor filter, the hasMore decision and the next-cursor anchor
      // live in keysetPage (./pagination.ts) — the house skeleton every feed
      // shares. The ORDER BY and the +1 lookahead stay here, on the same
      // columns as the cursor comparison.
      const selection = postSelection(viewerId);
      const page = await keysetPage({
        codec: postCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: post.createdAt,
        createdAtField: "createdAt",
        id: post.id,
        idField: "id",
        fetchPage: (cursorFilter) =>
          context.db
            .select(selection)
            .from(post)
            .innerJoin(user, eq(user.id, post.authorId))
            .where(and(...filters, cursorFilter))
            .orderBy(desc(post.createdAt), desc(post.id))
            .limit(input.limit + 1),
      });

      if (page.items.length === 0) return page;

      const focusedAuthorId = await visiblePostAuthorId(context.db, viewerId, input.parentId);
      if (!focusedAuthorId) return { ...page, continuations: [] };

      const continuations = await replyContinuationPages({
        db: context.db,
        viewerId,
        focusedAuthorId,
        rootPostIds: page.items.map((item) => item.id),
        limit: THREAD_REPLY_BRANCH_INITIAL_SIZE,
      });

      return { ...page, continuations };
    }),

  /**
   * One post plus the conversation above it — what `/post/$postId` renders.
   *
   * Two queries rather than one join, on purpose. The recursive CTE walks
   * `parent_id` upward collecting *ids only*, and a second ordinary select
   * turns those into rows through `postSelection`. That split is what lets
   * the ancestors reuse the same projection as every feed — `likeCount`,
   * `replyCount` and `viewerHasLiked` come along for free — instead of a
   * hand-mapped column list inside the CTE that would drift from it.
   *
   * The direct replies are deliberately NOT here: they are paginated, and
   * `post.list({ parentId })` already serves them. Returning a first page of
   * replies here too would give the same rows two cache homes with no way to
   * keep them in step.
   *
   * Session-optional since 0.4.0: this is the procedure a public post
   * permalink renders through. An anonymous reader gets the same rows a
   * signed-in one does — the projection's viewer-relative probes all read
   * false for a null viewer, and the visibility filter hides the same
   * banned/blocked authors it always has.
   */
  thread: publicReadProcedure
    .use(publicRateLimit(RATE_LIMITS.read))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const viewerId = context.user?.id ?? null;

      const [focused] = await context.db
        .select(postSelection(viewerId))
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(eq(post.id, input.postId), not(invisibleAuthor(viewerId))))
        .limit(1);

      if (!focused) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      // The common case by a wide margin: most posts are top-level, and
      // there is no chain to walk for those.
      if (!focused.parentId) {
        return { post: focused, ancestors: [], truncated: false };
      }

      const chain = await runSql<{ id: string; depth: number }>(
        context.db,
        sql`
        with recursive chain as (
          select ${post.id} as id, ${post.parentId} as parent_id, 0 as depth
          from ${post}
          where ${post.id} = ${sql.param(input.postId, post.id)}
          union all
          select ancestor.id, ancestor.parent_id, chain.depth + 1
          from ${post} as ancestor
          join chain on ancestor.id = chain.parent_id
          where chain.depth < ${THREAD_ANCESTOR_MAX}
        )
        -- depth 0 is the focused post itself, already selected above.
        -- Descending depth puts the root of the conversation first, which is
        -- the order it reads in.
        select id, depth from chain where depth > 0 order by depth desc
      `,
      );

      const ancestorIds = chain.map((row) => row.id);

      // Hidden ancestors are dropped rather than 404ing the thread: the
      // focused post's chain is walked through them, so a blocked middle
      // link must leave a gap, not take the whole conversation down.
      const rows = await context.db
        .select(postSelection(viewerId))
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(inArray(post.id, ancestorIds), not(invisibleAuthor(viewerId))));

      // `inArray` has no ordering of its own, so the CTE's depth ordering is
      // reapplied here rather than trusted from the second query.
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ancestors = ancestorIds.map((id) => byId.get(id)).filter((row) => row !== undefined);

      return {
        post: focused,
        ancestors,
        // The root-most ancestor still having a parent means the chain was
        // cut off by THREAD_ANCESTOR_MAX, not that we reached the top. Read
        // off the rows we already have rather than costing another query.
        truncated: ancestors[0]?.parentId != null,
      };
    }),

  /**
   * Resolves the link preview card for one absolute http(s) URL — the first
   * URL of a post, as recognized by the client's own linkifier (issue #260).
   * Session-optional since 0.4.0: a public post permalink renders the same
   * cards a feed does, so an anonymous caller may resolve one. The outbound
   * fetch behind a cache miss stays bounded by the SSRF guard, the size and
   * time caps in `./link-card-http.ts`, and the IP-keyed rate limit — and it
   * can only ever be spent on a URL the caller already read off a post they
   * can see.
   *
   * Every failure mode — refused address, dead target, timeout, no Open
   * Graph payload — answers `{ card: null }` so the post degrades to the
   * plain link it always rendered.
   */
  linkCard: publicReadProcedure
    .use(publicRateLimit(RATE_LIMITS.linkCard))
    .input(
      z.object({
        // The same scheme rule the client's linkifier applies, stated here so
        // a hand-crafted caller cannot ask the server to dial anything the
        // browser would not have linked.
        url: z.url({ protocol: /^https?$/ }).max(LINK_CARD_URL_MAX_LENGTH),
      }),
    )
    .handler(async ({ input, context }) => {
      return { card: await resolveLinkCard(context, input.url) };
    }),

  /**
   * Likes a post for the caller. Requires a session.
   *
   * `like` and `unlike` are separate, idempotent procedures rather than one
   * `toggle`. A toggle's result depends on the order two in-flight requests
   * happen to arrive in — a double-click can leave the post unliked — and it
   * can't be safely retried. These two state the intended end state, so
   * repeating either is a no-op and matches the optimistic UI update.
   */
  like: protectedProcedure
    .use(rateLimit(RATE_LIMITS.like))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: post.id, authorId: post.authorId })
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(eq(post.id, input.postId), not(invisibleAuthor(context.user.id))))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      // The like and its notification commit together: `.returning()` is
      // empty exactly when the (post_id, user_id) primary key swallowed the
      // insert as a duplicate, so a retried like mints no second
      // notification — the notification's exactly-once rides the like's own
      // idempotency instead of a second unique key a like→unlike→like
      // sequence would wrongly collapse.
      await context.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(postLike)
          .values({ postId: input.postId, userId: context.user.id })
          .onConflictDoNothing()
          .returning({ postId: postLike.postId });

        if (inserted.length > 0) {
          // A no-op for the author's own like — `insertNotification` drops
          // self-caused events so this needs no branch here.
          await insertNotification(tx, {
            recipientId: target.authorId,
            actorId: context.user.id,
            type: "like",
            postId: input.postId,
          });

          // Like-tier badge stamping (issue #308). A successful like is the
          // only moment a threshold can first be passed, so the stamping cost
          // is one index-only count per new like and nothing anywhere else —
          // a retried like never reaches this branch. The count read and the
          // stamp ride the like's own transaction, so a rollback leaves
          // neither half; the tier upgrades in place (see ./badge-stamping.ts
          // — one row per family, kept on a recede, `unlike` never unstamps).
          const badge = postLikeBadgeTierFor(await countLikes(tx, input.postId));
          if (badge) {
            await stampBadgeTier(tx, target.authorId, POST_LIKE_BADGE_TIERS, badge);
          }
        }
      });

      return {
        postId: input.postId,
        likeCount: await countLikes(context.db, input.postId),
        viewerHasLiked: true,
      };
    }),

  /** Removes the caller's like from a post. Requires a session; a no-op when the like isn't there. */
  unlike: protectedProcedure
    .use(rateLimit(RATE_LIMITS.like))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: post.id })
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(eq(post.id, input.postId), not(invisibleAuthor(context.user.id))))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      await context.db
        .delete(postLike)
        .where(and(eq(postLike.postId, input.postId), eq(postLike.userId, context.user.id)));

      return {
        postId: input.postId,
        likeCount: await countLikes(context.db, input.postId),
        viewerHasLiked: false,
      };
    }),

  /**
   * Reposts a post for the caller (issue #261). Requires a session.
   *
   * The same idempotent pair as `like`/`unlike` above, for the same reasons —
   * and the same target rules: a post whose author is hidden from the caller
   * reads as nonexistent. Tombstones are not checked, matching `like`: removal
   * is not invisibility, and the feed renders the stub for a repost whose
   * original was later removed or deleted.
   *
   * Reposting your own post is allowed (amplifying it to your followers).
   * "Reposting a repost" cannot be expressed: a repost is an event in
   * `post_repost`, not a post row, so the only id any client can send names an
   * original — re-amplifying an already-reposted post is a second repost event
   * about the same original, and no more.
   */
  repost: protectedProcedure
    .use(rateLimit(RATE_LIMITS.repost))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: post.id, authorId: post.authorId })
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(eq(post.id, input.postId), not(invisibleAuthor(context.user.id))))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      // The repost and its notification commit together — the like's shape
      // exactly. `.returning()` is empty exactly when the (post_id, user_id)
      // primary key swallowed the insert as a duplicate, so a retried repost
      // mints no second notification, and repost → unrepost → repost is
      // honestly three events. `unrepost` removes nothing: the rows are
      // historical, the same deal like notifications already get.
      await context.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(postRepost)
          .values({ postId: input.postId, userId: context.user.id })
          .onConflictDoNothing()
          .returning({ postId: postRepost.postId });

        if (inserted.length > 0) {
          // A no-op for the author's own repost (allowed, and dropped by
          // `insertNotification`'s self guard, like the like handler's).
          await insertNotification(tx, {
            recipientId: target.authorId,
            actorId: context.user.id,
            type: "repost",
            postId: input.postId,
          });
        }
      });

      return {
        postId: input.postId,
        repostCount: await countReposts(context.db, input.postId),
        viewerHasReposted: true,
      };
    }),

  /** Removes the caller's repost. Requires a session; a no-op when the repost isn't there. */
  unrepost: protectedProcedure
    .use(rateLimit(RATE_LIMITS.repost))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: post.id })
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(eq(post.id, input.postId), not(invisibleAuthor(context.user.id))))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      await context.db
        .delete(postRepost)
        .where(and(eq(postRepost.postId, input.postId), eq(postRepost.userId, context.user.id)));

      return {
        postId: input.postId,
        repostCount: await countReposts(context.db, input.postId),
        viewerHasReposted: false,
      };
    }),

  /**
   * Saves a post to the caller's private bookmarks (issue #262). Requires a
   * session.
   *
   * The same separate-idempotent-procedures reasoning as `like`/`unlike`
   * above, and the same mechanism: the (post_id, user_id) primary key makes
   * the duplicate impossible and `onConflictDoNothing` declines to error on
   * it. The one deliberate difference is the response: a like is public
   * state, so it answers with the post's count; a bookmark is private, so
   * there is no count to answer with — only the caller's own flag.
   *
   * The target check deliberately does NOT refuse a post the author has since
   * deleted or a moderator has removed: the row survives either tombstone,
   * and `unbookmark` must keep working for a post that is already gone from
   * fresh feeds. Bookmarking one is harmless for the same reason — the
   * bookmarks list applies the feed rules on read, so a tombstoned post never
   * renders there.
   */
  bookmark: protectedProcedure
    .use(rateLimit(RATE_LIMITS.bookmark))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: post.id })
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(eq(post.id, input.postId), not(invisibleAuthor(context.user.id))))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      await context.db
        .insert(postBookmark)
        .values({ postId: input.postId, userId: context.user.id })
        .onConflictDoNothing();

      return { postId: input.postId, viewerHasBookmarked: true };
    }),

  /**
   * Removes the post from the caller's bookmarks. Requires a session; a no-op
   * when the bookmark isn't there. A re-bookmark later inserts a fresh row, so
   * the post returns at the top of the page rather than at its old position —
   * "bookmark order" is the order the caller last saved, not a remembered
   * rank.
   *
   * Deliberately NO target check, unlike `bookmark` (and `unlike`) above. The
   * only row this can delete is the caller's own, the response is the same
   * whether the post is missing, tombstoned or merely invisible, and the
   * saver already knew it existed when they saved it — so the check buys no
   * privacy. Dropping it buys something instead: a post whose author has
   * since blocked the saver (or been banned) is filtered off the bookmarks
   * page, and with the check in place its saved row could then never be
   * removed at all.
   */
  unbookmark: protectedProcedure
    .use(rateLimit(RATE_LIMITS.bookmark))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      await context.db
        .delete(postBookmark)
        .where(
          and(eq(postBookmark.postId, input.postId), eq(postBookmark.userId, context.user.id)),
        );

      return { postId: input.postId, viewerHasBookmarked: false };
    }),
};
