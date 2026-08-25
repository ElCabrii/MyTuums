import { ORPCError } from "@orpc/server";
import { randomUUID } from "node:crypto";
import { and, desc, eq, getTableName, inArray, isNull, not, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@my-tuums/db";
import { follow, post, postAttachment, postLike, user, userBlock } from "@my-tuums/db/schema";
import { z } from "zod";
import {
  POST_MAX_LENGTH,
  POST_ATTACHMENT_MAX_BYTES,
  POST_ATTACHMENT_MAX_COUNT,
  POST_ATTACHMENT_MAX_TOTAL_BYTES,
  POST_PAGE_SIZE,
  POST_PAGE_SIZE_MAX,
  CURSOR_MAX_ENCODED_LENGTH,
  THREAD_ANCESTOR_MAX,
} from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { keysetPage } from "./pagination.js";
import { acquirePostMediaLifecycleLock } from "./post-media-lock.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { invisibleAuthor } from "./visibility.js";
import { acceptPostImage, type ImageRejection } from "./post-image.js";
import {
  discardPostAttachments,
  cleanupDeletedPostAttachments,
  postAttachmentRows,
  preparePostAttachments,
  writePostAttachments,
  type PostAttachmentInput,
} from "./post-media.js";
import { requireStorage } from "./profile-media.js";

/**
 * Feeds are keyset-paginated on `(post.created_at, post.id) DESC`; see
 * ./cursor.ts for why, and for the encoding. `post.id` is a uuid, so a cursor
 * minted here won't validate anywhere else.
 */
const postCursor = createCursorCodec(z.uuid());

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
 * Derived the same way — and for the same reasons — as `likeCount` above.
 *
 * The subquery needs its own alias for the table it is already inside, hence
 * `as reply`: without it `parent_id = id` would compare the outer row to
 * itself and count every post whose parent is its own id, i.e. nothing.
 */
const replyCount = sql<number>`(
  select count(*)::int from ${post} as reply where reply.parent_id = ${post.id}
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
  deleted: boolean;
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

export type PostAttachment = {
  id: string;
  url: string;
  position: number;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
};

/**
 * The outer post's columns, always table-qualified.
 *
 * Drizzle drops the table prefix from a column reference when the query it is
 * building has no join — a harmless optimization at the top level, and a
 * silent wrong answer inside the correlated subquery below: an unqualified
 * `"id"` there resolves against `post_attachment`, the inner scope, so the
 * correlation becomes `post_attachment.post_id = post_attachment.id` and the
 * aggregate matches nothing. It fails as an empty attachment list rather than
 * an error, which is exactly the kind of thing to spell out once here rather
 * than leave every caller to discover. Qualifying explicitly makes the
 * fragment correct whether or not the caller happens to join another table.
 */
function outerPost(column: "id" | "removed_at" | "deleted_at") {
  return sql`${sql.identifier(getTableName(post))}.${sql.identifier(column)}`;
}

/** Attachments are ordered in one correlated aggregate so every post surface shares the same shape. */
export function postAttachmentsSelection(includeTombstones = false) {
  return sql<PostAttachment[]>`coalesce((
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
    where ${postAttachment.postId} = ${outerPost("id")}
      ${
        includeTombstones
          ? sql``
          : sql`and ${outerPost("removed_at")} is null and ${outerPost("deleted_at")} is null`
      }
  ), '[]'::jsonb)`;
}

export const postAttachments = postAttachmentsSelection();

const POST_IMAGE_REJECTIONS = {
  type: "That image format isn't supported. Use a PNG, JPEG or WebP.",
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
 * their identity/content); removed/deleted parents remain present as stubs.
 */
function parentPreview(viewerId: string) {
  return sql<ParentPreview | null>`(
    select jsonb_build_object(
      'id', ${parentPost.id},
      'excerpt', case
        when ${parentPost.removedAt} is not null or ${parentPost.deletedAt} is not null then null
        else left(${parentPost.content}, ${PARENT_EXCERPT_LENGTH})
      end,
      'truncated', case
        when ${parentPost.removedAt} is not null or ${parentPost.deletedAt} is not null then false
        else char_length(${parentPost.content}) > ${PARENT_EXCERPT_LENGTH}
      end,
      'removed', ${parentPost.removedAt} is not null,
      'deleted', ${parentPost.deletedAt} is not null,
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
function viewerHasLiked(viewerId: string) {
  return sql<boolean>`exists (
    select 1 from ${postLike}
    where ${postLike.postId} = ${post.id} and ${postLike.userId} = ${viewerId}
  )`;
}

/**
 * The one projection every feed and thread reads posts through, so no view of
 * a post can drift from another's (an int test asserts the equality).
 */
export const postSelection = (viewerId: string) => ({
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
  createdAt: post.createdAt,
  // Null for a top-level post. The web app reads it to decide whether a card
  // needs a "Replying to" line, so it belongs in the shared selection rather
  // than only in the thread payload.
  parentId: post.parentId,
  parent: parentPreview(viewerId),
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
  viewerHasLiked: viewerHasLiked(viewerId),
});

async function countLikes(db: Database, postId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(postLike)
    .where(eq(postLike.postId, postId));

  return row?.count ?? 0;
}

type CreatedPost = {
  id: string;
  content: string;
  createdAt: Date;
  parentId: string | null;
};

/** Inserts the post and its already-prepared attachment rows atomically. */
async function insertPost(
  tx: Pick<Database, "insert">,
  args: {
    postId: string;
    authorId: string;
    content: string;
    parentId: string | undefined;
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
    })
    .returning({
      id: post.id,
      content: post.content,
      createdAt: post.createdAt,
      parentId: post.parentId,
    });

  if (!inserted) return undefined;
  if (args.prepared.length > 0)
    await tx.insert(postAttachment).values(postAttachmentRows(args.prepared));
  return inserted;
}

/**
 * The `post` procedure group: create, delete, list, thread, like, unlike.
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
          // Trim first so whitespace never persists as fake content. An empty
          // body is legal only when at least one attachment rides along — the
          // cross-field rule below is what keeps a fully empty submission out.
          content: z.string().trim().max(POST_MAX_LENGTH),
          /** Omit for a top-level post; set to reply to an existing one. */
          parentId: z.uuid().optional(),
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
      // a real post with a thread.
      if (input.parentId) {
        const [parent] = await context.db
          .select({ id: post.id })
          .from(post)
          .innerJoin(user, eq(user.id, post.authorId))
          .where(and(eq(post.id, input.parentId), not(invisibleAuthor(context.user.id))))
          .limit(1);

        if (!parent) {
          throw new ORPCError("NOT_FOUND", {
            message: "The post you replied to no longer exists.",
          });
        }
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

          return insertPost(tx, {
            postId,
            authorId: context.user.id,
            content: input.content,
            parentId: input.parentId,
            prepared,
          });
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
        // than columns.
        removed: false,
        deleted: false,
        removedReason: null,
        author: {
          id: context.user.id,
          name: context.user.name,
          username: context.user.username ?? null,
          displayUsername: context.user.displayUsername ?? null,
          image: context.user.image ?? null,
        },
        likeCount: 0,
        replyCount: 0,
        viewerHasLiked: false,
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
   * following feed, or one post's direct replies. Requires a session, like
   * every procedure in this app (issue #36).
   */
  list: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(
      z.object({
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
         */
        feed: z.enum(["global", "following"]).default("global"),
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
         * Replies are excluded by default, which is what keeps the home
         * timelines top-level only. A profile feed opts in, because a
         * person's profile is their whole activity.
         *
         * An explicit flag rather than inferring it from `authorId` keeps the
         * two axes independent — it is what a profile's "Both" view uses.
         */
        includeReplies: z.boolean().default(false),
        /**
         * The profile feed's three-way activity filter. `includeReplies` is
         * retained for existing clients and means `all` when true; `kind`
         * takes precedence when both are supplied. Keeping the legacy field
         * avoids changing existing query-key/input shapes during rollout.
         */
        kind: z.enum(["posts", "replies", "all"]).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const viewerId = context.user.id;
      const kind = input.kind ?? (input.includeReplies ? "all" : "posts");

      const filters = [
        input.authorId ? eq(post.authorId, input.authorId) : undefined,
        // Three-way, in priority order: an explicit `parentId` asks for one
        // post's replies; otherwise `kind` selects top-level posts, replies,
        // or both. The `is null` branch is what `post_created_idx` is a
        // partial index on, so the global and Following timelines match it
        // exactly.
        input.parentId
          ? eq(post.parentId, input.parentId)
          : kind === "posts"
            ? isNull(post.parentId)
            : kind === "replies"
              ? not(isNull(post.parentId))
              : undefined,
        // A semi-join rather than an INNER JOIN on `follow`: EXISTS cannot
        // duplicate a post row, whereas a join relies on the follow primary
        // key to avoid fanning out — true today, but a weaker statement of
        // intent. It also composes as one more entry in this array.
        //
        // Your own posts are included unconditionally. The composer sits
        // directly above this feed on the home page, and a post that appears
        // to vanish on submit reads as a bug.
        //
        // This walks post_created_idx newest-first and probes the follow
        // primary key per candidate. If it ever shows up slow — the bad case
        // is following very few people relative to global post volume — the
        // rewrite is `author_id = any(array(select following_id ...))`, which
        // follow_follower_created_idx already covers.
        input.feed === "following"
          ? sql`(${post.authorId} = ${viewerId} or exists (
              select 1 from ${follow}
              where ${follow.followingId} = ${post.authorId} and ${follow.followerId} = ${viewerId}
            ))`
          : undefined,
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
      return keysetPage({
        codec: postCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: post.createdAt,
        createdAtField: "createdAt",
        id: post.id,
        idField: "id",
        query: (cursorFilter) =>
          context.db
            .select(selection)
            .from(post)
            .innerJoin(user, eq(user.id, post.authorId))
            .where(and(...filters, cursorFilter))
            .orderBy(desc(post.createdAt), desc(post.id))
            .limit(input.limit + 1),
      });
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
   */
  thread: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const viewerId = context.user.id;

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

      const chain = await context.db.execute<{ id: string; depth: number }>(sql`
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
      `);

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
        .select({ id: post.id })
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(eq(post.id, input.postId), not(invisibleAuthor(context.user.id))))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      // The (post_id, user_id) primary key makes the duplicate impossible;
      // this just declines to error on it.
      await context.db
        .insert(postLike)
        .values({ postId: input.postId, userId: context.user.id })
        .onConflictDoNothing();

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
};
