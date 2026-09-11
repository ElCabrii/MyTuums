import {
  notification,
  post,
  user,
  video,
  videoCleanup,
  videoSubmission,
} from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { advanceStreamVideo, type StreamProcessor } from "./stream-job.js";
import { StreamError } from "./stream.js";
import { createTestUser, truncateAll } from "./testing/harness.js";
import { closeDb, db } from "./testing/runtime.js";

beforeEach(async () => {
  await truncateAll();
  await db.delete(video);
});
afterAll(closeDb);
const ready = { uploaded: true, ready: true, failed: false, duration: 6, width: 640, height: 360 };
const provider: StreamProcessor = {
  status: () => Promise.resolve(ready),
  uploadCaptions: () => Promise.resolve(),
};

async function pending(caption: string | null = null) {
  const author = await createTestUser();
  const id = crypto.randomUUID();
  await db.batch([
    db.insert(video).values({
      id,
      authorId: author.id,
      state: "queued",
      byteSize: 10,
      streamCreatorId: `mytuums-poc:${id}`,
      streamUid: id.replaceAll("-", ""),
      expiresAt: new Date(Date.now() + 1_800_000),
    }),
    db.insert(videoSubmission).values({
      videoId: id,
      authorId: author.id,
      content: "Private post text",
      isPrivate: true,
      caption,
      captionLanguage: caption === null ? null : "en",
    }),
  ]);
  return { id, author };
}

it("keeps processing private until ready and publishes exactly once on retry", async () => {
  const { id } = await pending("WEBVTT\n\n00:00.000 --> 00:01.000\nPrivate captions");
  expect(
    await advanceStreamVideo(
      db,
      { ...provider, status: () => Promise.resolve({ ...ready, ready: false }) },
      id,
    ),
  ).toBe("waiting");
  expect(await db.select().from(post)).toHaveLength(0);
  const result = await advanceStreamVideo(db, provider, id);
  expect(result).toBe("done");
  expect(await advanceStreamVideo(db, provider, id)).toBe("done");
  expect(await db.select().from(post)).toMatchObject([
    { content: "Private post text", isPrivate: true },
  ]);
  expect(await db.select().from(video)).toMatchObject([
    { state: "published", playback: { captionLanguage: "en" } },
  ]);
  expect(await db.select().from(videoSubmission)).toHaveLength(0);
});

it("retries an ambiguous caption upload without publishing an incomplete video", async () => {
  const text = "WEBVTT\n\n00:00.000 --> 00:01.000\nPrivate captions";
  const { id } = await pending(text);
  let saved: string | undefined;
  await expect(
    advanceStreamVideo(
      db,
      {
        ...provider,
        uploadCaptions: (_id, _uid, _language, caption) => {
          saved = caption;
          return Promise.reject(new StreamError("unavailable"));
        },
      },
      id,
    ),
  ).rejects.toThrow("The video provider could not complete this operation.");
  expect(saved).toBe(text);
  expect(await db.select().from(post)).toHaveLength(0);
  expect(await db.select().from(videoSubmission)).toHaveLength(1);
  expect(await advanceStreamVideo(db, provider, id)).toBe("done");
  expect(await db.select().from(post)).toHaveLength(1);
});

it.each(["cancel", "delete-account", "expire"] as const)(
  "rechecks %s after provider I/O before sending captions",
  async (change) => {
    const { id, author } = await pending("WEBVTT\n\nPrivate captions");
    let sent = false;
    const result = await advanceStreamVideo(
      db,
      {
        ...provider,
        status: async () => {
          if (change === "delete-account") await db.delete(user).where(eq(user.id, author.id));
          else
            await db
              .update(video)
              .set(change === "cancel" ? { state: "cancelled" } : { expiresAt: new Date(0) })
              .where(eq(video.id, id));
          return ready;
        },
        uploadCaptions: () => {
          sent = true;
          return Promise.resolve();
        },
      },
      id,
    );
    expect(result).toBe("done");
    expect(sent).toBe(false);
    expect(await db.select().from(post)).toHaveLength(0);
    expect(await db.select().from(videoCleanup)).toHaveLength(1);
  },
);

it.each(["ownership", "not_private", "invalid_response"] as const)(
  "fails %s safely instead of retrying untrusted media",
  async (reason) => {
    const { id } = await pending();
    expect(
      await advanceStreamVideo(
        db,
        { ...provider, status: () => Promise.reject(new StreamError(reason)) },
        id,
      ),
    ).toBe("done");
    expect(await db.select().from(video)).toMatchObject([{ state: "failed" }]);
    expect(await db.select().from(videoSubmission)).toHaveLength(0);
    expect(await db.select().from(notification)).toMatchObject([{ type: "video_failed" }]);
  },
);

it("retains work after transient provider failure, but enforces the stored deadline before the next request", async () => {
  const { id } = await pending();
  await expect(
    advanceStreamVideo(
      db,
      { ...provider, status: () => Promise.reject(new StreamError("unavailable")) },
      id,
    ),
  ).rejects.toThrow("The video provider could not complete this operation.");
  expect(await db.select().from(videoSubmission)).toHaveLength(1);
  await db
    .update(video)
    .set({ expiresAt: new Date(0) })
    .where(eq(video.id, id));
  const unreachable: StreamProcessor = {
    status: () => Promise.reject(new Error("Provider must not be reached after expiry")),
    uploadCaptions: () => Promise.reject(new Error("Provider must not be reached after expiry")),
  };
  expect(await advanceStreamVideo(db, unreachable, id)).toBe("done");
  expect(await db.select().from(video)).toMatchObject([{ state: "failed" }]);
});

it("rejects provider-ready media outside the duration policy", async () => {
  const { id } = await pending();
  expect(
    await advanceStreamVideo(
      db,
      { ...provider, status: () => Promise.resolve({ ...ready, duration: 301 }) },
      id,
    ),
  ).toBe("done");
  expect(await db.select().from(video)).toMatchObject([{ state: "failed" }]);
  expect(await db.select().from(post)).toHaveLength(0);
});
