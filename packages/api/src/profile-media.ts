/** Profile image uploads publish through D1; durable intents protect storage and cleanup. */
import { ORPCError } from "@orpc/server";
import type { Database } from "@my-tuums/db";
import { and, eq, sql } from "drizzle-orm";
import { mediaIntent, user } from "@my-tuums/db/schema";
import type { AllowedImageType, ImageKind } from "./constants.js";
import { imageObjectKey, mediaPathFor } from "./image.js";
import { beginMediaUpload, cleanupMediaIntents, mediaUploadIsLive } from "./media-intents.js";
import type { ObjectStorage } from "./object-storage.js";

export function requireStorage(context: { storage: ObjectStorage | null }): ObjectStorage {
  if (!context.storage) {
    throw new ORPCError("NOT_IMPLEMENTED", {
      message: "Image uploads aren't configured on this server.",
    });
  }
  return context.storage;
}

export interface ReplaceInput {
  kind: ImageKind;
  displayBytes: Uint8Array;
  displayType: AllowedImageType;
  originalBytes: Uint8Array;
  originalType: AllowedImageType;
}

export interface ReplaceResult {
  kind: ImageKind;
  url: string;
  originalUrl: string;
}

/**
 * Every upload uses fresh immutable paths. Record them before PUT, then publish
 * both columns and consume the live intent in one batch. Cleanup triggers record
 * the superseded paths in that same commit, including concurrent replacements.
 * Never delete newly uploaded objects on an ambiguous database acknowledgement.
 */
export async function replaceProfileMedia(
  db: Database,
  storage: ObjectStorage,
  userId: string,
  input: ReplaceInput,
): Promise<ReplaceResult> {
  const id = crypto.randomUUID();
  const scope = `profile:${userId}`;
  const displayKey = imageObjectKey(input.kind, userId, input.displayType, "display", id);
  const originalKey = imageObjectKey(input.kind, userId, input.originalType, "original", id);
  const url = mediaPathFor(displayKey);
  const originalUrl = mediaPathFor(originalKey);
  const uploadId = await beginMediaUpload(db, scope, [url, originalUrl]);
  await storage.put(displayKey, input.displayBytes, input.displayType);
  await storage.put(originalKey, input.originalBytes, input.originalType);

  const display = input.kind === "avatar" ? user.image : user.bannerImage;
  const original = input.kind === "avatar" ? user.imageOriginal : user.bannerImageOriginal;
  const [updated] = await db.batch([
    db
      .update(user)
      .set(
        input.kind === "avatar"
          ? { image: url, imageOriginal: originalUrl }
          : { bannerImage: url, bannerImageOriginal: originalUrl },
      )
      .where(and(eq(user.id, userId), mediaUploadIsLive(uploadId)))
      .returning({ id: user.id }),
    db.delete(mediaIntent).where(
      and(
        eq(mediaIntent.id, uploadId),
        sql`exists (select 1 from ${user} where ${user.id} = ${userId}
        and ${display} = ${url} and ${original} = ${originalUrl})`,
      ),
    ),
  ]);
  if (updated.length === 0) {
    throw new ORPCError("CONFLICT", {
      message: "The image upload expired or the account no longer exists.",
    });
  }
  await cleanupMediaIntents(db, storage, scope).catch(() => {
    console.error({ event: "profile_media_cleanup_deferred" });
  });
  return { kind: input.kind, url, originalUrl };
}

export interface RemoveResult {
  kind: ImageKind;
  url: null;
}

/** Clearing a slot also records cleanup through the database trigger. */
export async function removeProfileMedia(
  db: Database,
  storage: ObjectStorage,
  userId: string,
  kind: ImageKind,
): Promise<RemoveResult> {
  await db
    .update(user)
    .set(
      kind === "avatar"
        ? { image: null, imageOriginal: null }
        : { bannerImage: null, bannerImageOriginal: null },
    )
    .where(eq(user.id, userId));
  await cleanupMediaIntents(db, storage, `profile:${userId}`).catch(() => {
    console.error({ event: "profile_media_cleanup_deferred" });
  });
  return { kind, url: null };
}
