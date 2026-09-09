import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, closeDb } from "@my-tuums/db";
import { assertTestDatabase } from "@my-tuums/db/testing";
import { video, videoCleanup } from "@my-tuums/db/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestUser, truncateAll } from "./testing/harness.js";
import { createVideoUploads } from "./video-uploads.js";
import { VIDEO_PART_BYTES, type VideoPart, type VideoUploadStorage } from "./video-storage.js";
import { cleanVideoStorage, reconcileVideoObjects } from "./video-maintenance.js";

beforeAll(() => {
  assertTestDatabase();
});
beforeEach(truncateAll);
afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/** Models provider state separately from responses so lost acknowledgements are real ambiguity. */
function multipartStorage() {
  const parts = new Map<string, VideoPart[]>();
  const objects = new Map<string, number>();
  let loseCompletionResponse = false;
  const storage: VideoUploadStorage = {
    startMultipart(key) {
      parts.set(key, []);
      return Promise.resolve(randomUUID());
    },
    signPart(key, _id, number, byteSize) {
      return Promise.resolve(`https://storage.invalid/${key}?part=${number}&bytes=${byteSize}`);
    },
    listParts(key) {
      return Promise.resolve(parts.get(key) ?? []);
    },
    completeMultipart(key) {
      objects.set(
        key,
        (parts.get(key) ?? []).reduce((sum, part) => sum + part.byteSize, 0),
      );
      parts.delete(key);
      return loseCompletionResponse
        ? Promise.reject(new Error("response lost"))
        : Promise.resolve();
    },
    abortMultipart(key) {
      parts.delete(key);
      return Promise.resolve();
    },
    sourceSize(key) {
      return Promise.resolve(objects.get(key) ?? null);
    },
  };
  return {
    storage,
    parts,
    objects,
    loseCompletion: () => {
      loseCompletionResponse = true;
    },
  };
}

describe("resumable video uploads (issue #368)", () => {
  it("resumes only confirmed, correctly sized parts and accepts a lost completion response", async () => {
    const author = await createTestUser();
    const provider = multipartStorage();
    const uploads = createVideoUploads(db, provider.storage, { send: () => Promise.resolve(null) });
    const session = await uploads.begin(author.id, VIDEO_PART_BYTES + 100);
    const key = `videos/${session.id}/source`;
    provider.parts.set(key, [
      { number: 1, byteSize: VIDEO_PART_BYTES, etag: "first" },
      { number: 2, byteSize: 99, etag: "truncated" },
    ]);
    expect(await uploads.status(session.id, author.id)).toMatchObject({
      completedParts: [1],
      state: "uploading",
    });
    await expect(uploads.finish(session.id, author.id)).rejects.toMatchObject({
      reason: "not_ready",
    });
    provider.parts.set(key, [
      { number: 1, byteSize: VIDEO_PART_BYTES, etag: "first" },
      { number: 2, byteSize: 100, etag: "last" },
    ]);
    provider.loseCompletion();
    expect(await uploads.finish(session.id, author.id)).toEqual({
      id: session.id,
      state: "uploaded",
    });
    expect(await uploads.finish(session.id, author.id)).toEqual({
      id: session.id,
      state: "uploaded",
    });
    expect(await db.select().from(video)).toMatchObject([{ state: "uploaded" }]);
  });

  it("recovers after the provider completed but the API died before marking the upload complete", async () => {
    const author = await createTestUser();
    const provider = multipartStorage();
    const uploads = createVideoUploads(db, provider.storage, { send: () => Promise.resolve(null) });
    const session = await uploads.begin(author.id, 100);
    const key = `videos/${session.id}/source`;
    provider.objects.set(key, 100);
    provider.parts.delete(key);
    expect(await uploads.status(session.id, author.id)).toMatchObject({
      state: "uploading",
      completedParts: [1],
    });
    expect(await uploads.finish(session.id, author.id)).toMatchObject({ state: "uploaded" });
  });

  it("rejects another author's capability, out-of-bounds parts, cancelled sessions, and expired sessions", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const provider = multipartStorage();
    const uploads = createVideoUploads(db, provider.storage, { send: () => Promise.resolve(null) });
    const session = await uploads.begin(author.id, 100);
    await expect(uploads.part(session.id, stranger.id, 1)).rejects.toMatchObject({
      reason: "not_found",
    });
    await expect(uploads.finish(session.id, stranger.id)).rejects.toMatchObject({
      reason: "not_found",
    });
    await expect(uploads.part(session.id, author.id, 2)).rejects.toMatchObject({
      reason: "unavailable",
    });
    await uploads.cancel(session.id, author.id);
    await expect(uploads.finish(session.id, author.id)).rejects.toMatchObject({
      reason: "unavailable",
    });
    const expired = await uploads.begin(author.id, 100);
    await db
      .update(video)
      .set({ expiresAt: new Date(0) })
      .where(eq(video.id, expired.id));
    await expect(uploads.part(expired.id, author.id, 1)).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("retains deletion debt during an outage and collects a late write after cleanup already finished", async () => {
    const author = await createTestUser();
    const provider = multipartStorage();
    const uploads = createVideoUploads(db, provider.storage, { send: () => Promise.resolve(null) });
    const session = await uploads.begin(author.id, 100);
    const key = `videos/${session.id}/source`;
    provider.objects.set(key, 100);
    await uploads.cancel(session.id, author.id);
    const failed = await cleanVideoStorage(db, {
      abortMultipart: (key, id) => provider.storage.abortMultipart(key, id),
      removePrefix: () => Promise.reject(new Error("provider unavailable")),
    });
    expect(failed).toEqual({ cleaned: 0, deferred: 1 });
    expect(await db.select().from(videoCleanup)).toMatchObject([{ attempts: 1 }]);
    const cleaner = {
      abortMultipart: (key: string, id: string) => provider.storage.abortMultipart(key, id),
      removePrefix(prefix: string) {
        for (const name of provider.objects.keys())
          if (name.startsWith(prefix)) provider.objects.delete(name);
        return Promise.resolve();
      },
    };
    await db.update(videoCleanup).set({ nextAttemptAt: new Date(0) });
    expect(await cleanVideoStorage(db, cleaner)).toEqual({ cleaned: 1, deferred: 0 });
    expect(await db.select().from(video)).toEqual([]);
    expect(provider.objects.size).toBe(0);
    const late = `videos/${session.id}/attempts/${randomUUID()}/late.m4s`;
    provider.objects.set(late, 50);
    await reconcileVideoObjects(db, {
      listKeys: () => Promise.resolve([...provider.objects.keys()]),
      listMultipart: () => Promise.resolve([]),
      abortMultipart: (key, id) => provider.storage.abortMultipart(key, id),
      remove(name) {
        provider.objects.delete(name);
        return Promise.resolve();
      },
    });
    expect(await cleanVideoStorage(db, cleaner)).toEqual({ cleaned: 1, deferred: 0 });
    expect(provider.objects.size).toBe(0);
    expect(await db.select().from(videoCleanup)).toEqual([]);
  });
});
