import { post, postAttachment, user, video } from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { createTestUser, seedPosts, truncateAll } from "./testing/harness.js";
import { closeDb, db } from "./testing/runtime.js";
import { resolveVideoMedia } from "./video-media.js";
import { publicPostHead } from "./public-post-head.js";
import type { StreamService } from "./stream.js";

beforeEach(async () => {
  await truncateAll();
  await db.delete(video);
});
afterAll(closeDb);

async function published() {
  const author = await createTestUser();
  const [target] = await seedPosts(author.id, 1);
  const id = crypto.randomUUID();
  await db.insert(video).values({
    id,
    authorId: author.id,
    postId: target.id,
    state: "published",
    streamCreatorId: `mytuums-poc:${id}`,
    streamUid: id.replaceAll("-", ""),
    byteSize: 100,
    expiresAt: new Date(),
    playback: { width: 640, height: 360, duration: 4.5, captionLanguage: "en" },
  });
  await db.insert(postAttachment).values({
    postId: target.id,
    videoId: id,
    position: 0,
    mediaPath: `/media/videos/${id}/master.m3u8`,
    contentType: "application/vnd.apple.mpegurl",
    byteSize: 100,
    width: 640,
    height: 360,
  });
  return { author, postId: target.id, id, prefix: `videos/${id}/` };
}

const delivery: Pick<StreamService, "signedVideoUrl" | "readCaptions"> = {
  signedVideoUrl: (_id, _uid, kind, time) =>
    Promise.resolve(
      `https://customer-synthetic.cloudflarestream.com/signed-token/${kind}?time=${time}`,
    ),
  readCaptions: () => Promise.resolve("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n"),
};

it("gates manifest tokens, posters, previews and captions on current post visibility", async () => {
  const item = await published();
  const stranger = await createTestUser();
  await db.update(post).set({ isPrivate: true }).where(eq(post.id, item.postId));
  const resources = ["master.m3u8", "cover.jpg", "previews.vtt", "preview-2.jpg", "captions.vtt"];
  const noAccess: typeof delivery = {
    signedVideoUrl: () => Promise.reject(new Error("Unauthorized provider call")),
    readCaptions: () => Promise.reject(new Error("Unauthorized provider call")),
  };
  for (const resource of resources) {
    expect(await resolveVideoMedia(db, noAccess, item.prefix + resource, null)).toBeNull();
    expect(await resolveVideoMedia(db, noAccess, item.prefix + resource, stranger.id)).toBeNull();
    expect(
      await resolveVideoMedia(db, delivery, item.prefix + resource, item.author.id),
    ).not.toBeNull();
  }
  for (const resource of ["source", "360.m3u8", "arbitrary.jpg", "preview-1.jpg", "preview-6.jpg"])
    expect(
      await resolveVideoMedia(db, noAccess, item.prefix + resource, item.author.id),
    ).toBeNull();
  await db.update(post).set({ isPrivate: false }).where(eq(post.id, item.postId));
  expect(await resolveVideoMedia(db, delivery, item.prefix + "master.m3u8", null)).not.toBeNull();
  expect(await publicPostHead(db, item.postId)).toMatchObject({
    imagePath: `/media/${item.prefix}cover.jpg`,
  });
  await db.update(post).set({ removedAt: new Date() }).where(eq(post.id, item.postId));
  expect(
    await resolveVideoMedia(db, noAccess, item.prefix + "master.m3u8", stranger.id),
  ).toBeNull();
  expect(
    await resolveVideoMedia(db, delivery, item.prefix + "master.m3u8", item.author.id),
  ).not.toBeNull();
  await db.update(user).set({ role: "moderator" }).where(eq(user.id, stranger.id));
  expect(
    await resolveVideoMedia(db, delivery, item.prefix + "master.m3u8", stranger.id),
  ).not.toBeNull();
});

it("rechecks visibility after a provider round-trip and never serves an unpublished video", async () => {
  const item = await published();
  const stranger = await createTestUser();
  const late: typeof delivery = {
    ...delivery,
    async signedVideoUrl(...args) {
      await db.update(post).set({ isPrivate: true }).where(eq(post.id, item.postId));
      return delivery.signedVideoUrl(...args);
    },
  };
  expect(await resolveVideoMedia(db, late, item.prefix + "master.m3u8", stranger.id)).toBeNull();
  await db.update(video).set({ state: "ready" }).where(eq(video.id, item.id));
  expect(
    await resolveVideoMedia(db, delivery, item.prefix + "master.m3u8", item.author.id),
  ).toBeNull();
});

it("builds a bounded preview index whose image requests still pass through authorization", async () => {
  const item = await published();
  const result = await resolveVideoMedia(
    db,
    delivery,
    item.prefix + "previews.vtt",
    item.author.id,
  );
  if (!result || !("body" in result)) throw new Error("Expected preview VTT");
  expect(result.contentType).toBe("text/vtt");
  expect(result.body.match(/ --> /g)).toHaveLength(3);
  expect(result.body).toContain("00:00:04.000 --> 00:00:04.500");
  expect(result.body).toContain(`/media/${item.prefix}preview-4.jpg#xywh=0,0,160,90`);
  expect(result.body).not.toContain("signed-token");
  await db
    .update(video)
    .set({ playback: { width: 640, height: 360, duration: 300, captionLanguage: null } })
    .where(eq(video.id, item.id));
  const longest = await resolveVideoMedia(
    db,
    delivery,
    item.prefix + "previews.vtt",
    item.author.id,
  );
  if (!longest || !("body" in longest)) throw new Error("Expected preview VTT");
  expect(longest.body.match(/ --> /g)).toHaveLength(150);
  expect(longest.body.length).toBeLessThan(100_000);
  expect(
    await resolveVideoMedia(db, delivery, item.prefix + "captions.vtt", item.author.id),
  ).toBeNull();
});
