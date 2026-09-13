import { post, video, videoCleanup, videoSubmission } from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import type { StreamService } from "./stream.js";
import { createVideoUploads } from "./video-uploads.js";
import { cleanStreamUploads, expireStreamUploads } from "./stream-cleanup.js";
import { createTestUser, truncateAll } from "./testing/harness.js";
import { closeDb, db } from "./testing/runtime.js";
import { sql } from "drizzle-orm";

beforeEach(async () => {
  await truncateAll();
  await db.delete(video);
});
afterAll(closeDb);

function provider() {
  const objects = new Map<string, { owner: string; uploaded: boolean }>();
  const stream: StreamService = {
    creatorId: (id) => `mytuums-test:${id}`,
    createUpload(id) {
      const uid = crypto.randomUUID().replaceAll("-", "");
      objects.set(uid, { owner: id, uploaded: false });
      return Promise.resolve({ uid, uploadUrl: `https://upload.videodelivery.net/tus/${uid}` });
    },
    status(id, uid) {
      const object = objects.get(uid);
      if (object && object.owner !== id) return Promise.reject(new Error("Wrong owner"));
      return Promise.resolve(
        object
          ? {
              uploaded: object.uploaded,
              ready: false,
              failed: false,
              duration: -1,
              width: 0,
              height: 0,
            }
          : null,
      );
    },
    uploadCaptions: () => Promise.resolve(),
    signedVideoUrl: () => Promise.reject(new Error("Unexpected playback operation")),
    readCaptions: () => Promise.reject(new Error("Unexpected caption operation")),
    remove(id, uid) {
      if (objects.get(uid)?.owner !== id && objects.has(uid))
        return Promise.reject(new Error("Wrong owner"));
      objects.delete(uid);
      return Promise.resolve();
    },
    findUploads: (id) =>
      Promise.resolve([...objects].filter(([, object]) => object.owner === id).map(([uid]) => uid)),
  };
  const uploads = createVideoUploads(db, stream, { dispatch: () => Promise.resolve(false) });
  return { objects, stream, uploads };
}

it("keeps the resumable capability owner-only and requires explicit submission after upload", async () => {
  const owner = await createTestUser();
  const other = await createTestUser();
  const { objects, uploads } = provider();
  const upload = await uploads.begin(owner.id, 500_000_000);
  const status = await uploads.status(upload.id, owner.id);
  expect(status.uploadUrl).toMatch(/^https:\/\/upload.videodelivery.net\/tus\//);
  expect(status.expiresAt.getTime() - Date.now()).toBeGreaterThan(86_390_000);
  await expect(uploads.status(upload.id, other.id)).rejects.toMatchObject({ reason: "not_found" });
  await expect(uploads.finish(upload.id, other.id)).rejects.toMatchObject({ reason: "not_found" });
  await expect(uploads.cancel(upload.id, other.id)).rejects.toMatchObject({ reason: "not_found" });
  await expect(uploads.finish(upload.id, owner.id)).rejects.toMatchObject({ reason: "not_ready" });
  for (const value of objects.values()) value.uploaded = true;
  expect(await uploads.finish(upload.id, owner.id)).toEqual({ id: upload.id, state: "uploaded" });
  expect((await uploads.status(upload.id, owner.id)).uploadUrl).toBeNull();
  expect(await db.select().from(post)).toHaveLength(0);
  expect(await db.select().from(videoSubmission)).toHaveLength(0);
  const submission = await uploads.submit({
    videoId: upload.id,
    authorId: owner.id,
    content: "Confirmed",
    parentId: null,
    quotedPostId: null,
    isPrivate: false,
    caption: null,
    captionLanguage: null,
  });
  expect(submission.status).toBe("pending");
  expect(await db.select().from(videoSubmission)).toHaveLength(1);
});

it("rolls back cancellation if cleanup cannot be recorded and retries failed provider deletion", async () => {
  const owner = await createTestUser();
  const { stream, uploads, objects } = provider();
  const upload = await uploads.begin(owner.id, 10);
  await db.run(sql`create trigger reject_stream_cleanup_test before insert on video_cleanup
    begin select raise(abort, 'injected cleanup failure'); end`);
  try {
    await expect(uploads.cancel(upload.id, owner.id)).rejects.toThrow();
  } finally {
    await db.run(sql`drop trigger reject_stream_cleanup_test`);
  }
  expect((await uploads.status(upload.id, owner.id)).state).toBe("uploading");
  await uploads.cancel(upload.id, owner.id);
  await uploads.cancel(upload.id, owner.id);
  expect(await db.select().from(videoCleanup)).toHaveLength(1);
  expect((await db.select().from(video))[0].uploadUrl).toBeNull();
  const failed = await cleanStreamUploads(db, {
    ...stream,
    remove: () => Promise.reject(new Error("Unavailable")),
  });
  expect(failed.deferred).toBe(1);
  expect(objects.size).toBe(1);
  await db.update(videoCleanup).set({ nextAttemptAt: new Date(0) });
  await cleanStreamUploads(db, stream);
  expect(objects.size).toBe(0);
  // A quiet tombstone still protects against late visibility of an ambiguous create.
  expect(await db.select().from(videoCleanup)).toHaveLength(1);
});

it("retains a late provider UID when account deletion wins during upload creation", async () => {
  const owner = await createTestUser();
  const fake = provider();
  const create = fake.stream.createUpload.bind(fake.stream);
  const uploads = createVideoUploads(
    db,
    {
      ...fake.stream,
      async createUpload(...args) {
        await db.$client.prepare("delete from user where id = ?").bind(owner.id).run();
        return create(...args);
      },
    },
    { dispatch: () => Promise.resolve(false) },
  );
  await expect(uploads.begin(owner.id, 10)).rejects.toMatchObject({ reason: "unavailable" });
  const [debt] = await db.select().from(videoCleanup);
  expect(debt.streamUid).toBe([...fake.objects.keys()][0]);
  await cleanStreamUploads(db, fake.stream);
  expect(fake.objects.size).toBe(0);
  await db.update(videoCleanup).set({ createdAt: new Date(0), nextAttemptAt: new Date(0) });
  await cleanStreamUploads(db, fake.stream);
  expect(await db.select().from(videoCleanup)).toHaveLength(0);
  expect(await db.select().from(video)).toHaveLength(0);
});

it("reaps a provider creation that appears after its first empty recovery scan", async () => {
  const owner = await createTestUser();
  const fake = provider();
  let delayedOwner = "";
  const uploads = createVideoUploads(
    db,
    {
      ...fake.stream,
      createUpload(id) {
        delayedOwner = id;
        return Promise.reject(new Error("Creation acknowledgement lost"));
      },
    },
    { dispatch: () => Promise.resolve(false) },
  );
  await expect(uploads.begin(owner.id, 10)).rejects.toThrow();
  await cleanStreamUploads(db, fake.stream);
  expect(await db.select().from(videoCleanup)).toHaveLength(1);
  fake.objects.set("a".repeat(32), { owner: delayedOwner, uploaded: true });
  await db.update(videoCleanup).set({ nextAttemptAt: new Date(0) });
  await cleanStreamUploads(db, fake.stream);
  expect(fake.objects.size).toBe(0);
});

it("expires abandoned uploads and cannot resurrect cancellation during completion", async () => {
  const owner = await createTestUser();
  const fake = provider();
  const expired = await fake.uploads.begin(owner.id, 10);
  await db
    .update(video)
    .set({ expiresAt: new Date(0) })
    .where(eq(video.id, expired.id));
  expect(await expireStreamUploads(db)).toBe(1);
  await expect(fake.uploads.status(expired.id, owner.id)).rejects.toMatchObject({
    reason: "unavailable",
  });
  const upload = await fake.uploads.begin(owner.id, 10);
  const uploads = createVideoUploads(
    db,
    {
      ...fake.stream,
      async status() {
        await fake.uploads.cancel(upload.id, owner.id);
        return { uploaded: true, ready: false, failed: false, duration: -1, width: 0, height: 0 };
      },
    },
    { dispatch: () => Promise.resolve(false) },
  );
  await expect(uploads.finish(upload.id, owner.id)).rejects.toMatchObject({
    reason: "unavailable",
  });
  expect((await db.select().from(video).where(eq(video.id, upload.id)))[0].state).toBe("cancelled");
});

it("recovers provider completion after an interrupted status request and repeated finish", async () => {
  const owner = await createTestUser();
  const fake = provider();
  const upload = await fake.uploads.begin(owner.id, 100);
  for (const object of fake.objects.values()) object.uploaded = true;
  let unavailable = true;
  const uploads = createVideoUploads(
    db,
    {
      ...fake.stream,
      status(...args) {
        if (unavailable) return Promise.reject(new Error("Provider response lost"));
        return fake.stream.status(...args);
      },
    },
    { dispatch: () => Promise.resolve(false) },
  );
  await expect(uploads.finish(upload.id, owner.id)).rejects.toThrow();
  expect((await uploads.status(upload.id, owner.id)).state).toBe("uploading");
  unavailable = false;
  expect(await uploads.finish(upload.id, owner.id)).toEqual({ id: upload.id, state: "uploaded" });
  expect(await uploads.finish(upload.id, owner.id)).toEqual({ id: upload.id, state: "uploaded" });
});
