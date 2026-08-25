/**
 * Post-attachment storage and read authorization.
 *
 * Post images are deliberately separate from profile media: a post can have
 * several ordered objects, and its visibility follows the post (including
 * moderation tombstones and blocks), not just the signed-in state.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, not, or } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { post, postAttachment, user } from "@my-tuums/db/schema";
import { roleAtLeast } from "./roles.js";
import { invisibleAuthor } from "./visibility.js";
import { mediaPathFor, objectKeyFromMediaPath } from "./image.js";
import type { AllowedImageType } from "./constants.js";
import type { Storage } from "./storage.js";

const EXTENSION = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
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
 * Writes nothing to the database. The caller can therefore prepare objects
 * before its post transaction and remove every prepared key if that
 * transaction fails.
 */
export function preparePostAttachments(
  authorId: string,
  postId: string,
  inputs: readonly PostAttachmentInput[],
): PreparedPostAttachment[] {
  return inputs.map((input, position) => {
    const id = randomUUID();
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
  storage: Storage,
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
  storage: Storage,
  attachments: readonly Pick<PreparedPostAttachment, "key">[],
): Promise<void> {
  await Promise.all(
    attachments.map(async ({ key }) => {
      try {
        await storage.remove(key);
      } catch (error) {
        // Reconciliation can retry a provider outage; never hide the original
        // post/storage failure behind a cleanup error.
        // Do not include the object key in logs: media paths can be correlated
        // with an author's private post while this cleanup runs after a failed
        // write or a hard account deletion.
        console.error("Failed to delete post attachment object", error);
      }
    }),
  );
}

/**
 * Removes the non-restorable media of an author's deleted post.
 *
 * The relation is deleted first, after the post tombstone has committed. A
 * failed object deletion therefore becomes an orphan the guarded reconciler
 * can remove, rather than a live-looking row that keeps an inaccessible object
 * forever. Moderation removals use no such cleanup because they are reversible.
 */
export async function cleanupDeletedPostAttachments(
  db: Database,
  storage: Storage | null,
  postId: string,
): Promise<void> {
  const rows = await db
    .select({ mediaPath: postAttachment.mediaPath })
    .from(postAttachment)
    .where(eq(postAttachment.postId, postId));
  if (rows.length === 0) return;

  await db.delete(postAttachment).where(eq(postAttachment.postId, postId));
  if (!storage) return;

  const keys = rows
    .map(({ mediaPath }) => objectKeyFromMediaPath(mediaPath))
    .filter((key): key is string => key !== null)
    .map((key) => ({ key }));
  await discardPostAttachments(storage, keys);
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

/**
 * Authorizes a `/media/` request for a post attachment. Moderators can inspect
 * reported/tombstoned posts; ordinary readers must pass the normal author
 * visibility predicate, and a post the author deleted is closed to everyone
 * but a moderator.
 *
 * The one relaxation is for the author of a MODERATION-removed post: they may
 * still fetch their own attachments, which is what lets the appeal page show
 * someone the images they are contesting the removal of. It discloses nothing
 * — the author uploaded these bytes — and the objects are still there, because
 * a removal is reversible and deliberately does not reap them (see
 * `discardPostAttachments`). An author-DELETED post stays closed for the
 * opposite reason: `cleanupDeletedPostAttachments` reaps those objects, so
 * there would be nothing behind the signature anyway.
 */
export async function canViewPostMedia(
  db: Database,
  key: string,
  viewerId: string,
): Promise<boolean> {
  const [viewer] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, viewerId))
    .limit(1);
  if (!viewer) return false;

  const isModerator = roleAtLeast(viewer.role ?? "user", "moderator");
  const path = mediaPathFor(key);
  const visiblePost = isModerator
    ? undefined
    : and(
        isNull(post.deletedAt),
        not(invisibleAuthor(viewerId)),
        // The ONLY term the author is exempt from is the removal tombstone.
        // Ban and block visibility still applies to them, so this cannot
        // become a way to read anything back out of a hidden account.
        or(isNull(post.removedAt), eq(post.authorId, viewerId)),
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
