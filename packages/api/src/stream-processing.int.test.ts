import { notification, user, video, videoCleanup, videoSubmission } from "@my-tuums/db/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { expireStreamProcessing, failStreamVideo } from "./stream-processing.js";
import { createTestUser, truncateAll } from "./testing/harness.js";
import { closeDb, db } from "./testing/runtime.js";

beforeEach(async () => {
  await truncateAll();
  await db.delete(video);
});
afterAll(closeDb);

async function pending(authorId: string, expiresAt = new Date(Date.now() + 1_800_000)) {
  const id = crypto.randomUUID();
  await db.batch([
    db.insert(video).values({
      id,
      authorId,
      state: "processing",
      byteSize: 10,
      streamCreatorId: `mytuums-poc:${id}`,
      streamUid: id.replaceAll("-", ""),
      expiresAt,
    }),
    db.insert(videoSubmission).values({
      videoId: id,
      authorId,
      content: "Unpublished text",
      caption: "Private captions",
      captionLanguage: "en",
      isPrivate: true,
    }),
  ]);
  return id;
}

it("commits one failure notice, private-text erasure and Stream cleanup across concurrent retries", async () => {
  const owner = await createTestUser();
  const id = await pending(owner.id);
  const results = await Promise.all(Array.from({ length: 4 }, () => failStreamVideo(db, id)));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await db.select().from(videoSubmission)).toHaveLength(0);
  expect(await db.select().from(video)).toMatchObject([{ state: "failed", uploadUrl: null }]);
  expect(await db.select().from(notification)).toMatchObject([
    { type: "video_failed", videoId: id, recipientId: owner.id, actorId: null },
  ]);
  const debt = await db.select().from(videoCleanup);
  expect(debt).toMatchObject([{ videoId: id, streamUid: id.replaceAll("-", "") }]);
  expect(JSON.stringify(debt)).not.toContain("Unpublished text");
  expect(JSON.stringify(debt)).not.toContain("Private captions");
});

it("preserves pending text and state when recording cleanup or the failure notice fails", async () => {
  const owner = await createTestUser();
  const id = await pending(owner.id);
  for (const table of [videoCleanup, notification]) {
    await db.run(sql`create trigger reject_stream_failure_test before insert on ${table}
      begin select raise(abort, 'injected failure'); end`);
    try {
      await expect(failStreamVideo(db, id)).rejects.toThrow();
    } finally {
      await db.run(sql`drop trigger reject_stream_failure_test`);
    }
    expect(await db.select().from(video)).toMatchObject([{ state: "processing" }]);
    expect(await db.select().from(videoSubmission)).toMatchObject([
      { content: "Unpublished text", caption: "Private captions" },
    ]);
    expect(await db.select().from(notification)).toHaveLength(0);
    expect(await db.select().from(videoCleanup)).toHaveLength(0);
  }
});

it("uses the stored deadline and cannot fail cancellation or notify a deleted account", async () => {
  const owner = await createTestUser();
  const active = await pending(owner.id);
  const expired = await pending(owner.id, new Date(0));
  const cancelled = await pending(owner.id, new Date(0));
  await db.update(video).set({ state: "cancelled" }).where(eq(video.id, cancelled));
  await db.delete(videoSubmission).where(eq(videoSubmission.videoId, cancelled));
  expect(await failStreamVideo(db, active, true)).toBe(false);
  expect(await expireStreamProcessing(db)).toEqual({ scanned: 1, failed: 1 });
  expect(await failStreamVideo(db, cancelled)).toBe(false);
  expect(await db.select().from(notification)).toMatchObject([{ videoId: expired }]);
  await db.delete(user).where(eq(user.id, owner.id));
  expect(await failStreamVideo(db, active)).toBe(true);
  expect(await db.select().from(notification)).toHaveLength(0);
  expect(await db.select().from(videoCleanup)).toHaveLength(3);
});

it("bounds each recovery pass and keeps overdue work due for the next pass", async () => {
  const owner = await createTestUser();
  const rows = Array.from({ length: 51 }, () => {
    const id = crypto.randomUUID();
    return db.insert(video).values({
      id,
      authorId: owner.id,
      state: "queued",
      byteSize: 10,
      streamCreatorId: `mytuums-poc:${id}`,
      expiresAt: new Date(0),
    });
  });
  await db.batch([rows[0], ...rows.slice(1)]);
  expect(await expireStreamProcessing(db)).toEqual({ scanned: 50, failed: 50 });
  expect(await expireStreamProcessing(db)).toEqual({ scanned: 1, failed: 1 });
  expect(await db.select().from(videoCleanup)).toHaveLength(51);
});
