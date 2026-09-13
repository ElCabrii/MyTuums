import {
  notification,
  post,
  postAttachment,
  user,
  userBlock,
  video,
  videoCleanup,
  videoSubmission,
} from "@my-tuums/db/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { submitVideo } from "./video-lifecycle.js";
import { publishStreamVideo, recordStreamReady } from "./stream-publication.js";
import { failStreamVideo } from "./stream-processing.js";
import { createTestUser, seedPosts, truncateAll } from "./testing/harness.js";
import { closeDb, db } from "./testing/runtime.js";

beforeEach(async () => {
  await truncateAll();
  await db.delete(video);
});
afterAll(closeDb);
const metadata = { width: 640, height: 360, duration: 6, captionLanguage: null };

async function submitted(
  authorId: string,
  target: { parentId?: string; quotedPostId?: string } = {},
) {
  const id = crypto.randomUUID();
  const uid = id.replaceAll("-", "");
  await db.insert(video).values({
    id,
    authorId,
    streamCreatorId: `mytuums-test:${id}`,
    streamUid: uid,
    state: "uploaded",
    byteSize: 1000,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const submission = await submitVideo(
    db,
    { dispatch: () => Promise.resolve(false) },
    {
      videoId: id,
      authorId,
      content: "Confirmed private draft",
      parentId: target.parentId ?? null,
      quotedPostId: target.quotedPostId ?? null,
      isPrivate: true,
      caption: null,
      captionLanguage: null,
    },
  );
  return { id, uid, postId: submission.id };
}

it("requires verified readiness and publishes one post, attachment and reply notice across duplicate delivery", async () => {
  const author = await createTestUser();
  const target = await createTestUser();
  const [parent] = await seedPosts(target.id, 1);
  const item = await submitted(author.id, { parentId: parent.id });
  expect(await publishStreamVideo(db, item.id)).toBe(false);
  expect(await db.select().from(post).where(eq(post.authorId, author.id))).toHaveLength(0);
  expect(await recordStreamReady(db, item.id, "a".repeat(32), metadata)).toBe(false);
  expect(await recordStreamReady(db, item.id, item.uid, metadata)).toBe(true);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => publishStreamVideo(db, item.id)),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await db.select().from(post).where(eq(post.id, item.postId))).toMatchObject([
    {
      authorId: author.id,
      content: "Confirmed private draft",
      parentId: parent.id,
      isPrivate: true,
    },
  ]);
  expect(await db.select().from(postAttachment)).toMatchObject([
    { postId: item.postId, videoId: item.id, width: 640, height: 360, byteSize: 1000 },
  ]);
  expect(await db.select().from(video)).toMatchObject([
    { state: "published", postId: item.postId, playback: metadata },
  ]);
  expect(await db.select().from(notification)).toMatchObject([
    { type: "reply", recipientId: target.id, actorId: author.id, postId: item.postId },
  ]);
  expect(await db.select().from(videoSubmission)).toHaveLength(0);
  expect(await db.select().from(videoCleanup)).toHaveLength(0);
  expect(await failStreamVideo(db, item.id)).toBe(false);
});

it("rolls back the ready state and all post effects if notification insertion fails", async () => {
  const author = await createTestUser();
  const target = await createTestUser();
  const [quoted] = await seedPosts(target.id, 1);
  const item = await submitted(author.id, { quotedPostId: quoted.id });
  await recordStreamReady(db, item.id, item.uid, metadata);
  await db.run(sql`create trigger reject_video_publication_test before insert on notification
    begin select raise(abort, 'injected late publication failure'); end`);
  try {
    await expect(publishStreamVideo(db, item.id)).rejects.toThrow();
  } finally {
    await db.run(sql`drop trigger reject_video_publication_test`);
  }
  expect(await db.select().from(video)).toMatchObject([{ state: "ready", postId: null }]);
  expect(await db.select().from(videoSubmission)).toHaveLength(1);
  expect(await db.select().from(post).where(eq(post.id, item.postId))).toHaveLength(0);
  expect(await db.select().from(postAttachment)).toHaveLength(0);
  expect(await db.select().from(notification)).toHaveLength(0);
  expect(await publishStreamVideo(db, item.id)).toBe(true);
  expect(await db.select().from(notification)).toMatchObject([
    { type: "quote", postId: item.postId },
  ]);
});

it.each([
  "author-ban",
  "target-ban",
  "target-private",
  "post-private",
  "block-author",
  "block-target",
  "missing-target",
] as const)(
  "rechecks %s at publication and fails privately with recoverable cleanup",
  async (change) => {
    const author = await createTestUser();
    const target = await createTestUser();
    const [parent] = await seedPosts(target.id, 1);
    const item = await submitted(author.id, { parentId: parent.id });
    await recordStreamReady(db, item.id, item.uid, metadata);
    if (change === "author-ban" || change === "target-ban")
      await db
        .update(user)
        .set({ banned: true })
        .where(eq(user.id, change === "author-ban" ? author.id : target.id));
    if (change === "target-private")
      await db.update(user).set({ isPrivate: true }).where(eq(user.id, target.id));
    if (change === "post-private")
      await db.update(post).set({ isPrivate: true }).where(eq(post.id, parent.id));
    if (change === "block-author")
      await db.insert(userBlock).values({ blockerId: author.id, blockedId: target.id });
    if (change === "block-target")
      await db.insert(userBlock).values({ blockerId: target.id, blockedId: author.id });
    if (change === "missing-target") await db.delete(user).where(eq(user.id, target.id));
    expect(await publishStreamVideo(db, item.id)).toBe(false);
    expect(await db.select().from(post).where(eq(post.id, item.postId))).toHaveLength(0);
    expect(await db.select().from(video)).toMatchObject([{ state: "failed" }]);
    expect(await db.select().from(videoSubmission)).toHaveLength(0);
    expect(await db.select().from(notification)).toMatchObject([
      { type: "video_failed", recipientId: author.id },
    ]);
    expect(await db.select().from(videoCleanup)).toMatchObject([
      { videoId: item.id, streamUid: item.uid },
    ]);
  },
);

it("keeps tombstone replies valid and suppresses self-notifications like ordinary publication", async () => {
  const author = await createTestUser();
  const [parent] = await seedPosts(author.id, 1);
  const item = await submitted(author.id, { parentId: parent.id });
  await recordStreamReady(db, item.id, item.uid, metadata);
  await db.update(post).set({ removedAt: new Date() }).where(eq(post.id, parent.id));
  expect(await publishStreamVideo(db, item.id)).toBe(true);
  expect(await db.select().from(notification)).toHaveLength(0);
});

it("refuses expired, cancelled and account-deleted work without resurrecting its text", async () => {
  const owner = await createTestUser();
  const expired = await submitted(owner.id);
  await recordStreamReady(db, expired.id, expired.uid, metadata);
  await db
    .update(video)
    .set({ expiresAt: new Date(0) })
    .where(eq(video.id, expired.id));
  expect(await publishStreamVideo(db, expired.id)).toBe(false);
  expect(await db.select().from(notification)).toHaveLength(1);
  const cancelled = await submitted(owner.id);
  await recordStreamReady(db, cancelled.id, cancelled.uid, metadata);
  await db.batch([
    db.update(video).set({ state: "cancelled", playback: null }).where(eq(video.id, cancelled.id)),
    db.delete(videoSubmission).where(eq(videoSubmission.videoId, cancelled.id)),
  ]);
  expect(await publishStreamVideo(db, cancelled.id)).toBe(false);
  const orphan = await submitted(owner.id);
  await db.delete(user).where(eq(user.id, owner.id));
  expect(await recordStreamReady(db, orphan.id, orphan.uid, metadata)).toBe(false);
  expect(await publishStreamVideo(db, orphan.id)).toBe(false);
  expect(await db.select().from(post)).toHaveLength(0);
  expect(await db.select().from(videoSubmission)).toHaveLength(0);
  expect(await db.select().from(videoCleanup)).toHaveLength(3);
});

it("refuses missing or out-of-policy Stream metadata in both the adapter and database", async () => {
  const owner = await createTestUser();
  const item = await submitted(owner.id);
  await expect(
    recordStreamReady(db, item.id, item.uid, { ...metadata, width: 1.5 }),
  ).rejects.toThrow();
  await expect(
    recordStreamReady(db, item.id, item.uid, { ...metadata, duration: 301 }),
  ).rejects.toThrow();
  for (const malformed of [{}, { ...metadata, width: 0 }, { ...metadata, duration: 301 }]) {
    await expect(
      db.run(
        sql`update video set state = 'ready', playback = ${JSON.stringify(malformed)} where id = ${item.id}`,
      ),
    ).rejects.toThrow();
  }
  expect((await db.select().from(video))[0].state).toBe("queued");
});
