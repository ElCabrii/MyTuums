/**
 * Post-attachment storage, read authorization, and the served projection.
 *
 * Post images are deliberately separate from profile media: a post can have
 * several ordered objects, and its visibility follows the post (including
 * moderation tombstones and blocks), not just the signed-in state.
 */
import { and, eq, getTableName, isNull, not, or, sql, type AnyColumn } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { post, postAttachment, user, video } from "@my-tuums/db/schema";
import { z } from "zod";
import { jsonDecoder } from "./sql.js";
import { roleAtLeast } from "./roles.js";
import { invisibleAuthor, privatePostHidden } from "./visibility.js";
import { mediaPathFor } from "./image.js";
import { mediaVariantKeys, type AllowedImageType } from "./constants.js";
import type { ObjectStorage } from "./object-storage.js";
import { cleanupMediaIntents } from "./media-intents.js";

const EXTENSION = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} satisfies Record<AllowedImageType, string>;

export interface PostAttachmentInput {
  bytes: Uint8Array;
  type: AllowedImageType;
  width: number;
  height: number;
}

/** A storage object plus the row that will point at it after the post commits. */
export interface PreparedPostAttachment {
  id: string;
  postId: string;
  position: number;
  key: string;
  mediaPath: string;
  contentType: AllowedImageType;
  byteSize: number;
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** A fresh, owner-scoped key; no filename or client URL participates. */
export function postImageObjectKey(
  authorId: string,
  postId: string,
  attachmentId: string,
  type: AllowedImageType,
): string {
  return `posts/${authorId}/${postId}/${attachmentId}.${EXTENSION[type]}`;
}

/**
 * Writes nothing. The caller records these keys as an upload intent before
 * storage writes, then atomically publishes their rows and consumes the intent.
 */
export function preparePostAttachments(
  authorId: string,
  postId: string,
  inputs: readonly PostAttachmentInput[],
): PreparedPostAttachment[] {
  return inputs.map((input, position) => {
    const id = crypto.randomUUID();
    const key = postImageObjectKey(authorId, postId, id, input.type);
    return {
      id,
      postId,
      position,
      key,
      mediaPath: mediaPathFor(key),
      contentType: input.type,
      byteSize: input.bytes.byteLength,
      width: input.width,
      height: input.height,
      bytes: input.bytes,
    };
  });
}

/** Uploads all prepared objects, cleaning the partial batch on failure. */
export async function writePostAttachments(
  storage: ObjectStorage,
  prepared: readonly PreparedPostAttachment[],
): Promise<void> {
  const written: PreparedPostAttachment[] = [];
  for (const attachment of prepared) {
    try {
      await storage.put(attachment.key, attachment.bytes, attachment.contentType);
      written.push(attachment);
    } catch (error) {
      // A provider may have committed a PUT before reporting a transport
      // error. Include the current key as well as prior successes so that
      // this failure path cannot leave a partially-written batch behind.
      await discardPostAttachments(storage, [...written, attachment]);
      throw error;
    }
  }
}

/**
 * Best-effort cleanup for objects that are not (or are no longer) referenced.
 *
 * A moderation tombstone intentionally does not call this: its row and object
 * remain available to the moderator path so a moderation restore is lossless.
 * An author's own tombstone is not restorable, so its rows are removed after
 * the post tombstone commits and this helper reaps the objects best-effort. A
 * hard account delete cascades any remaining rows, after which the guarded
 * reconciliation job removes the now-unreferenced objects eventually.
 */
export async function discardPostAttachments(
  storage: ObjectStorage,
  attachments: readonly Pick<PreparedPostAttachment, "key">[],
): Promise<void> {
  await Promise.all(
    attachments.flatMap(({ key }) => {
      // Derived variants go with their base: a variant outliving the base is
      // unreachable (nothing references it) until the reconciler notices.
      const keys = [key, ...mediaVariantKeys(key)];
      return keys.map(async (objectKey) => {
        try {
          await storage.remove(objectKey);
        } catch {
          // Reconciliation can retry a provider outage; never hide the original
          // post/storage failure behind a cleanup error.
          // Do not include the object key in logs: media paths can be correlated
          // with an author's private post while this cleanup runs after a failed
          // write or a hard account deletion.
          console.error({ event: "post_attachment_cleanup_deferred" });
        }
      });
    }),
  );
}

/** Retry the image cleanup recorded atomically with the author's tombstone. */
export async function cleanupDeletedPostAttachments(
  db: Database,
  storage: ObjectStorage | null,
  postId: string,
): Promise<void> {
  if (!storage) return;
  await cleanupMediaIntents(db, storage, `post:${postId}`).catch(() => {
    console.error({ event: "post_media_cleanup_deferred" });
  });
}

/** The row shape inserted after the post row exists. */
export function postAttachmentRows(
  prepared: readonly PreparedPostAttachment[],
): (typeof postAttachment.$inferInsert)[] {
  return prepared.map(
    ({ id, postId, position, mediaPath, contentType, byteSize, width, height }) => ({
      id,
      postId,
      position,
      mediaPath,
      contentType,
      byteSize,
      width,
      height,
    }),
  );
}

/** One served attachment — the wire shape every post surface renders. */
export const postAttachmentSchema = z.object({
  id: z.string(),
  url: z.string(),
  position: z.number(),
  contentType: z.string(),
  byteSize: z.number(),
  width: z.number(),
  height: z.number(),
  video: z
    .object({
      duration: z.number(),
      posterUrl: z.string(),
      previewUrl: z.string(),
      captionUrl: z.string().nullable(),
      captionLanguage: z.string().nullable(),
    })
    .optional(),
});
export type PostAttachment = z.infer<typeof postAttachmentSchema>;

/**
 * The outer post's columns, always table-qualified.
 *
 * Drizzle drops the table prefix from a column reference when the query it is
 * building has no join — a harmless optimization at the top level, and a
 * silent wrong answer inside a correlated subquery: an unqualified `"id"`
 * there resolves against `post_attachment`, the inner scope, so the
 * correlation becomes `post_attachment.post_id = post_attachment.id` and the
 * aggregate matches nothing. It fails as an empty attachment list rather than
 * an error, which is exactly the kind of thing to spell out once here rather
 * than leave every caller to discover. Qualifying explicitly makes the
 * fragment correct whether or not the caller happens to join another table.
 */
export function outerPost(column: "id" | "removed_at" | "deleted_at" | "quoted_post_id") {
  return sql`${sql.identifier(getTableName(post))}.${sql.identifier(column)}`;
}

/** Join-less outer queries also strip inner column qualifiers (issue #368). */
function attachmentColumn(column: AnyColumn) {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

/**
 * Attachments are ordered in one correlated aggregate so every post surface
 * shares the same shape. Lives here rather than in `posts.ts` so surfaces
 * that must not import the post router — the notification list, whose module
 * `posts.ts` already imports for `insertNotification` — still share the one
 * definition instead of cycling two modules or forking the projection.
 */
export function postAttachmentsSelection(includeTombstones = false) {
  const image = sql`json_object(
        'id', ${attachmentColumn(postAttachment.id)},
        'url', ${attachmentColumn(postAttachment.mediaPath)},
        'position', ${attachmentColumn(postAttachment.position)},
        'contentType', ${attachmentColumn(postAttachment.contentType)},
        'byteSize', ${attachmentColumn(postAttachment.byteSize)},
        'width', ${attachmentColumn(postAttachment.width)},
        'height', ${attachmentColumn(postAttachment.height)}
      )`;
  const playback = sql`json_object(
          'duration', ${attachmentColumn(video.playback)}->'duration',
          'posterUrl', replace(${attachmentColumn(postAttachment.mediaPath)}, 'master.m3u8', 'cover.jpg'),
          'previewUrl', replace(${attachmentColumn(postAttachment.mediaPath)}, 'master.m3u8', 'previews.vtt'),
          'captionUrl', case when json_extract(${attachmentColumn(video.playback)}, '$.captionLanguage') is not null
            then replace(${attachmentColumn(postAttachment.mediaPath)}, 'master.m3u8', 'captions.vtt') else null end,
          'captionLanguage', ${attachmentColumn(video.playback)}->'captionLanguage'
        )`;
  return sql<PostAttachment[]>`coalesce((
    select json_group_array(
      json(case when ${attachmentColumn(postAttachment.videoId)} is null then ${image}
        else json_set(${image}, '$.video', ${playback}) end)
      order by ${attachmentColumn(postAttachment.position)}
    )
    from ${postAttachment}
    left join ${video} on ${attachmentColumn(video.id)} = ${attachmentColumn(postAttachment.videoId)}
    where ${attachmentColumn(postAttachment.postId)} = ${outerPost("id")}
      ${
        includeTombstones
          ? sql``
          : sql`and ${outerPost("removed_at")} is null and ${outerPost("deleted_at")} is null`
      }
  ), '[]')`.mapWith(jsonDecoder(z.array(postAttachmentSchema)));
}

export const postAttachments = postAttachmentsSelection();

/**
 * Authorizes a `/media/` request for a post attachment. Moderators can inspect
 * reported/tombstoned posts; ordinary readers must pass the normal author
 * visibility predicate, and a post the author deleted is closed to everyone
 * but a moderator.
 *
 * `viewerId` may be `null` — the anonymous post-permalink reader (0.4.0) and
 * the public media that permalink renders. An anonymous viewer is never a
 * moderator and never an author, so they get the plain visibility rule: no
 * tombstoned post, no hidden author. The same SQL answers for them because a
 * NULL viewer id matches no block edge and no author row.
 *
 * The one relaxation is for the author of a MODERATION-removed post: they may
 * still fetch their own attachments, which is what lets the appeal page show
 * someone the images they are contesting the removal of. It discloses nothing
 * — the author uploaded these bytes — and the objects are still there, because
 * a removal is reversible and deliberately does not reap them (see
 * `discardPostAttachments`). An author-DELETED post stays closed for the
 * opposite reason: `cleanupDeletedPostAttachments` reaps those objects, so
 * there would be nothing behind the signature anyway.
 *
 * Variant keys (`…/uuid.png.w640.webp`, `media-variants.ts`) never reach this
 * function: `createMediaResolver` strips the marker and authorizes the BASE
 * key, which is what the row stores — so a variant is exactly as visible as
 * the object it derives from.
 */
export async function canViewPostMedia(
  db: Database,
  key: string,
  viewerId: string | null,
): Promise<boolean> {
  const [viewer] = viewerId
    ? await db.select({ role: user.role }).from(user).where(eq(user.id, viewerId)).limit(1)
    : [];
  // A named viewer whose account row is gone stays fail-closed, exactly as
  // before: their session's visibility rules cannot be evaluated.
  if (viewerId && !viewer) return false;

  const isModerator = viewer ? roleAtLeast(viewer.role ?? "user", "moderator") : false;
  const path = mediaPathFor(key);
  const visiblePost = isModerator
    ? undefined
    : and(
        isNull(post.deletedAt),
        not(invisibleAuthor(viewerId)),
        // Private posts and private-account posts (issue #328) gate the same
        // way: the author and approved followers pass, anyone else (including
        // anonymous) gets a 404 from the media route. Moderators bypass, like
        // the tombstones — they need the evidence in the case view.
        not(privatePostHidden(viewerId)),
        // The ONLY term the author is exempt from is the removal tombstone.
        // Ban and block visibility still applies to them, so this cannot
        // become a way to read anything back out of a hidden account. A null
        // viewer is no one's author, so they simply never get the exemption.
        or(isNull(post.removedAt), viewerId ? eq(post.authorId, viewerId) : sql`false`),
      );

  const [found] = await db
    .select({ id: postAttachment.id })
    .from(postAttachment)
    .innerJoin(post, eq(post.id, postAttachment.postId))
    .innerJoin(user, eq(user.id, post.authorId))
    .where(and(eq(postAttachment.mediaPath, path), visiblePost))
    .limit(1);

  return found !== undefined;
}
