import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { video, videoCleanup } from "@my-tuums/db/schema";
import { videoAttemptPrefix, videoPrefix } from "./video-lifecycle.js";
import type { VideoStorage } from "./video-storage.js";

/** Failed provider deletes remain due work with bounded retry frequency. */
export async function cleanVideoStorage(
  db: Database,
  storage: Pick<VideoStorage, "abortMultipart" | "removePrefix">,
): Promise<{ cleaned: number; deferred: number }> {
  let cleaned = 0;
  let deferred = 0;
  const due = await db
    .select({ id: videoCleanup.id })
    .from(videoCleanup)
    .where(lte(videoCleanup.nextAttemptAt, sql`now()`))
    .orderBy(videoCleanup.nextAttemptAt)
    .limit(50);
  for (const candidate of due)
    await db.transaction(async (tx) => {
      const [debt] = await tx
        .select()
        .from(videoCleanup)
        .where(eq(videoCleanup.id, candidate.id))
        .for("update", { skipLocked: true });
      if (!debt) return;
      try {
        if (debt.multipartId && debt.sourceKey)
          await storage.abortMultipart(debt.sourceKey, debt.multipartId);
        await storage.removePrefix(debt.prefix);
      } catch {
        deferred += 1;
        await tx
          .update(videoCleanup)
          .set({
            attempts: debt.attempts + 1,
            nextAttemptAt: new Date(
              Date.now() + Math.min(6 * 60 * 60, 30 * 2 ** Math.min(debt.attempts, 10)) * 1000,
            ),
          })
          .where(eq(videoCleanup.id, debt.id));
        return;
      }
      await tx.delete(videoCleanup).where(eq(videoCleanup.id, debt.id));
      if (debt.prefix === videoPrefix(debt.videoId)) {
        await tx
          .delete(video)
          .where(
            and(
              eq(video.id, debt.videoId),
              inArray(video.state, ["failed", "cancelled", "deleted"]),
            ),
          );
      }
      cleaned += 1;
    });
  return { cleaned, deferred };
}

/**
 * A crashed/stale process can write after a prior cleanup has finished. Scan
 * actual storage too: every live write already has a durable owner and attempt.
 */
export async function reconcileVideoObjects(
  db: Database,
  storage: Pick<VideoStorage, "listKeys" | "listMultipart" | "abortMultipart" | "remove">,
): Promise<void> {
  const keys = await storage.listKeys();
  const byVideo = new Map<string, string[]>();
  for (const key of keys) {
    const match = /^videos\/([0-9a-f-]{36})\//.exec(key);
    if (!match?.[1]) continue;
    const group = byVideo.get(match[1]) ?? [];
    group.push(key);
    byVideo.set(match[1], group);
  }
  for (const [id, objectKeys] of byVideo) {
    const [row] = await db.select().from(video).where(eq(video.id, id));
    if (!row || row.state === "failed" || row.state === "cancelled" || row.state === "deleted") {
      await db
        .insert(videoCleanup)
        .values({ videoId: id, prefix: videoPrefix(id) })
        .onConflictDoNothing();
      continue;
    }
    const prefix = row.attemptId ? videoAttemptPrefix(id, row.attemptId) : null;
    const publishedAssets = new Set(row.assets.map((asset) => `${prefix}${asset.name}`));
    for (const key of objectKeys) {
      if (key === row.sourceKey && !row.sourceDeletedAt) continue;
      if (
        prefix &&
        key.startsWith(prefix) &&
        (row.state === "processing" || publishedAssets.has(key))
      )
        continue;
      // Only a retired attempt or deleted source reaches this branch. Its
      // owning video remains, so publication cannot make it current again.
      await storage.remove(key);
    }
  }
  for (const upload of await storage.listMultipart()) {
    const [row] = await db.select().from(video).where(eq(video.sourceKey, upload.key));
    // Allow the small create-upload/register-id window. Unknown capabilities
    // older than this are leftovers, including a provider success after timeout.
    if (
      row?.state === "uploading" &&
      row.expiresAt.getTime() > Date.now() &&
      (row.multipartId === upload.uploadId ||
        upload.createdAt.getTime() > Date.now() - 10 * 60 * 1000)
    )
      continue;
    await storage.abortMultipart(upload.key, upload.uploadId);
  }
}
