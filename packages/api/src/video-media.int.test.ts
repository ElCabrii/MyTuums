import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, closeDb } from "@my-tuums/db";
import { assertTestDatabase } from "@my-tuums/db/testing";
import { post, postAttachment, video } from "@my-tuums/db/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  seedPosts,
  testStorage,
  testStorageObjects,
  truncateAll,
} from "./testing/harness.js";
import { resolveVideoMedia } from "./video-media.js";
import { publicPostHead } from "./public-post-head.js";

beforeAll(() => {
  assertTestDatabase();
});
beforeEach(truncateAll);
afterAll(async () => {
  await truncateAll();
  await closeDb();
});

describe("authorized video playback (issue #368)", () => {
  it("gates every asset on the post and rewrites all manifest references through authorization", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const [published] = await seedPosts(author.id, 1);
    await db.update(post).set({ isPrivate: true }).where(eq(post.id, published.id));
    const id = randomUUID();
    const attemptId = randomUUID();
    const prefix = `videos/${id}/attempts/${attemptId}/`;
    const contents = new Map([
      ["master.m3u8", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n360.m3u8\n"],
      [
        "360.m3u8",
        '#EXTM3U\n#EXT-X-MAP:URI="360-init.mp4"\n#EXTINF:4,\n360-00000.m4s\n#EXT-X-ENDLIST\n',
      ],
      ["360-init.mp4", "init"],
      ["360-00000.m4s", "segment"],
      ["cover.jpg", "cover"],
      ["previews.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nsprite-001.jpg#xywh=0,0,160,90\n"],
      ["sprite-001.jpg", "sprite"],
      ["captions.vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n"],
    ]);
    const assets = [...contents].map(([name, content]) => ({
      name,
      byteSize: Buffer.byteLength(content),
      contentType: name.endsWith(".vtt")
        ? "text/vtt"
        : name.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/mp4",
    }));
    await db.insert(video).values({
      id,
      authorId: author.id,
      postId: published.id,
      state: "published",
      byteSize: 100,
      sourceKey: `videos/${id}/source`,
      attemptId,
      sourceDeletedAt: new Date(),
      expiresAt: new Date(),
      playback: { width: 640, height: 360, duration: 4, frameRate: 30, renditions: [] },
      assets,
    });
    await db.insert(postAttachment).values({
      postId: published.id,
      videoId: id,
      position: 0,
      mediaPath: `/media/${prefix}master.m3u8`,
      contentType: "application/vnd.apple.mpegurl",
      byteSize: 100,
      width: 640,
      height: 360,
    });
    for (const [name, content] of contents)
      testStorageObjects.set(`${prefix}${name}`, {
        contentType: "application/octet-stream",
        bytes: Buffer.from(content),
      });
    for (const name of contents.keys()) {
      expect(await resolveVideoMedia(db, testStorage, `${prefix}${name}`, null)).toBeNull();
      expect(await resolveVideoMedia(db, testStorage, `${prefix}${name}`, stranger.id)).toBeNull();
      expect(
        await resolveVideoMedia(db, testStorage, `${prefix}${name}`, author.id),
      ).not.toBeNull();
    }
    const master = await resolveVideoMedia(db, testStorage, `${prefix}master.m3u8`, author.id);
    const playlist = await resolveVideoMedia(db, testStorage, `${prefix}360.m3u8`, author.id);
    const previews = await resolveVideoMedia(db, testStorage, `${prefix}previews.vtt`, author.id);
    if (
      !master ||
      !("body" in master) ||
      !playlist ||
      !("body" in playlist) ||
      !previews ||
      !("body" in previews)
    )
      throw new Error("Expected authorized text assets.");
    expect(master.body).toContain(`/media/${prefix}360.m3u8`);
    expect(playlist.body).toContain(`URI="/media/${prefix}360-init.mp4"`);
    expect(previews.body).toContain(`/media/${prefix}sprite-001.jpg#xywh=0,0,160,90`);
    expect(await resolveVideoMedia(db, testStorage, `${prefix}unlisted.mp4`, author.id)).toBeNull();
    expect(await resolveVideoMedia(db, testStorage, `videos/${id}/source`, author.id)).toBeNull();
    await db.update(post).set({ isPrivate: false }).where(eq(post.id, published.id));
    expect(await resolveVideoMedia(db, testStorage, `${prefix}master.m3u8`, null)).not.toBeNull();
    expect(await publicPostHead(db, published.id)).toMatchObject({
      imagePath: `/media/${prefix}cover.jpg`,
    });
    await db.update(post).set({ deletedAt: new Date() }).where(eq(post.id, published.id));
    expect(await resolveVideoMedia(db, testStorage, `${prefix}master.m3u8`, null)).toBeNull();
  });
});
