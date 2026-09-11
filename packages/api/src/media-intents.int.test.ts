import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mediaIntent, user, post, postAttachment, linkCard } from "@my-tuums/db/schema";
import { db, closeDb } from "./testing/runtime.js";
import {
  contextFor,
  createTestUser,
  testStorage,
  testStorageObjects,
  truncateAll,
} from "./testing/harness.js";
import { replaceProfileMedia, type ReplaceInput } from "./profile-media.js";
import { cleanupMediaIntents, readMediaReferences } from "./media-intents.js";
import { reconcileMedia } from "./reconcile-media.js";
import { purgeLinkCard, resolveLinkCard } from "./link-card.js";
import type { Context } from "./context.js";
import { deletePost } from "./post-mutations.js";

beforeEach(truncateAll);
afterAll(closeDb);

const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4y8AARAwQCgAfrgP19hgqWQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const image: ReplaceInput = {
  kind: "avatar",
  displayBytes: png,
  displayType: "image/png",
  originalBytes: png,
  originalType: "image/png",
};

it("protects both profile objects when reconciliation runs before the row commits", async () => {
  const owner = await createTestUser();
  const storage = {
    ...testStorage,
    put: async (key: string, bytes: Uint8Array, type: string) => {
      await testStorage.put(key, bytes, type);
      const sweep = await reconcileMedia({
        storage: testStorage,
        readReferences: () => readMediaReferences(db),
      });
      expect(sweep.deleted).toBe(0);
      expect(testStorageObjects.has(key)).toBe(true);
    },
  };
  const result = await replaceProfileMedia(db, storage, owner.id, image);
  expect(testStorageObjects.size).toBe(2);
  const [stored] = await db.select().from(user).where(eq(user.id, owner.id));
  expect(stored.image).toBe(result.url);
  expect(await db.select().from(mediaIntent)).toEqual([]);
});

it("rolls back a swap if intent consumption fails, then retries cleanup without touching the old pair", async () => {
  const owner = await createTestUser();
  const previous = await replaceProfileMedia(db, testStorage, owner.id, image);
  await db.run(sql`create trigger reject_media_consumption_test before delete on media_intent
    when old.kind = 'upload' begin select raise(abort, 'injected intent consumption failure'); end`);
  try {
    await expect(replaceProfileMedia(db, testStorage, owner.id, image)).rejects.toThrow();
  } finally {
    await db.run(sql`drop trigger reject_media_consumption_test`);
  }
  const [stored] = await db.select().from(user).where(eq(user.id, owner.id));
  expect(stored.image).toBe(previous.url);
  const intents = await db.select().from(mediaIntent);
  expect(intents).toHaveLength(1);
  expect(intents[0].kind).toBe("upload");
  expect(testStorageObjects.size).toBe(4);
  await db.update(mediaIntent).set({ readyAt: new Date(0) });
  const remove = vi.spyOn(testStorage, "remove").mockRejectedValueOnce(new Error("storage down"));
  try {
    expect(await cleanupMediaIntents(db, testStorage)).toEqual({ completed: 0, failed: 1 });
    expect(await db.select().from(mediaIntent)).toHaveLength(1);
  } finally {
    remove.mockRestore();
  }
  expect(await cleanupMediaIntents(db, testStorage)).toEqual({ completed: 1, failed: 0 });
  expect([...testStorageObjects.keys()].sort()).toEqual(
    [previous.url.slice(7), previous.originalUrl.slice(7)].sort(),
  );
});

it("refuses publication after an upload expires and is cleaned while PUT is finishing", async () => {
  const owner = await createTestUser();
  const previous = await replaceProfileMedia(db, testStorage, owner.id, image);
  const storage = {
    ...testStorage,
    put: async (key: string, bytes: Uint8Array, type: string) => {
      await testStorage.put(key, bytes, type);
      if (key.includes(".orig.")) {
        await db
          .update(mediaIntent)
          .set({ readyAt: new Date(0) })
          .where(eq(mediaIntent.kind, "upload"));
        await cleanupMediaIntents(db, testStorage);
      }
    },
  };
  await expect(replaceProfileMedia(db, storage, owner.id, image)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  const [stored] = await db.select().from(user).where(eq(user.id, owner.id));
  expect(stored.image).toBe(previous.url);
  expect([...testStorageObjects.keys()].sort()).toEqual(
    [previous.url.slice(7), previous.originalUrl.slice(7)].sort(),
  );
});

it("retains profile and post image cleanup after the owner's account cascade", async () => {
  const owner = await createTestUser();
  await replaceProfileMedia(db, testStorage, owner.id, image);
  await replaceProfileMedia(db, testStorage, owner.id, { ...image, kind: "banner" });
  const [written] = await db
    .insert(post)
    .values({ authorId: owner.id, content: "An image" })
    .returning();
  const key = `posts/${owner.id}/${written.id}/${crypto.randomUUID()}.png`;
  await testStorage.put(key, png, "image/png");
  await db.insert(postAttachment).values({
    postId: written.id,
    position: 0,
    mediaPath: `/media/${key}`,
    contentType: "image/png",
    byteSize: png.length,
    width: 2,
    height: 2,
  });
  await db.delete(user).where(eq(user.id, owner.id));
  expect(await db.select().from(postAttachment)).toEqual([]);
  expect(await db.select().from(mediaIntent)).toHaveLength(2);
  expect(testStorageObjects.size).toBe(5);
  expect(await cleanupMediaIntents(db, testStorage)).toEqual({ completed: 2, failed: 0 });
  expect(testStorageObjects.size).toBe(0);
});

it("commits an image tombstone and cleanup together, preserving the post when recording cleanup fails", async () => {
  const owner = await createTestUser();
  const [written] = await db
    .insert(post)
    .values({ authorId: owner.id, content: "An image" })
    .returning();
  const key = `posts/${owner.id}/${written.id}/${crypto.randomUUID()}.png`;
  await testStorage.put(key, png, "image/png");
  await db.insert(postAttachment).values({
    postId: written.id,
    position: 0,
    mediaPath: `/media/${key}`,
    contentType: "image/png",
    byteSize: png.length,
    width: 2,
    height: 2,
  });
  await db.run(sql`create trigger reject_image_cleanup_test before insert on media_intent
    when new.kind = 'cleanup' begin select raise(abort, 'injected cleanup failure'); end`);
  try {
    await expect(deletePost(db, owner.id, written.id)).rejects.toThrow();
  } finally {
    await db.run(sql`drop trigger reject_image_cleanup_test`);
  }
  const [unchanged] = await db.select().from(post).where(eq(post.id, written.id));
  expect(unchanged.deletedAt).toBeNull();
  expect(await db.select().from(postAttachment)).toHaveLength(1);
  expect(await db.select().from(mediaIntent)).toEqual([]);
  expect(testStorageObjects.has(key)).toBe(true);

  await deletePost(db, owner.id, written.id);
  expect(await db.select().from(postAttachment)).toEqual([]);
  expect(await db.select().from(mediaIntent)).toHaveLength(1);
  expect(testStorageObjects.has(key)).toBe(true);
  expect(await cleanupMediaIntents(db, testStorage)).toEqual({ completed: 1, failed: 0 });
  expect(testStorageObjects.has(key)).toBe(false);
});

const pageUrl = "https://example.com/article";
const html =
  '<meta property="og:title" content="A title"><meta property="og:image" content="/cover.png">';
it.each(["success", "failure"])(
  "preserves a purge that commits during %s revalidation",
  async (outcome) => {
    const owner = await createTestUser();
    await db.insert(linkCard).values({
      url: pageUrl,
      title: "Old title",
      domain: "example.com",
      fetchedAt: new Date(0),
    });
    const context: Context = {
      ...contextFor(owner),
      linkTransport: {
        lookup: () => Promise.resolve(["93.184.216.34"]),
        fetch: async (target) => {
          if (target.pathname === "/cover.png")
            return new Response(png, { headers: { "content-type": "image/png" } });
          await purgeLinkCard(context, { url: pageUrl, actorId: owner.id, reason: "Removed" });
          if (outcome === "failure") throw new Error("network failure");
          return new Response(html, { headers: { "content-type": "text/html" } });
        },
      },
    };
    expect(await resolveLinkCard(context, pageUrl)).toBeNull();
    const [stored] = await db.select().from(linkCard);
    expect(stored.title).toBeNull();
    expect(stored.imageMediaPath).toBeNull();
    expect(stored.purgedBy).toBe(owner.id);
    await db.update(mediaIntent).set({ readyAt: new Date(0) });
    await cleanupMediaIntents(db, testStorage);
    expect(testStorageObjects.size).toBe(0);
  },
);

it("returns a text-only card after an ambiguous image PUT and later cleans the unreferenced image", async () => {
  const owner = await createTestUser();
  const context: Context = {
    ...contextFor(owner),
    storage: {
      ...testStorage,
      put: async (key, bytes, type) => {
        await testStorage.put(key, bytes, type);
        throw new Error("lost acknowledgement");
      },
    },
    linkTransport: {
      lookup: () => Promise.resolve(["93.184.216.34"]),
      fetch: (target) =>
        Promise.resolve(
          target.pathname === "/cover.png"
            ? new Response(png, { headers: { "content-type": "image/png" } })
            : new Response(html, { headers: { "content-type": "text/html" } }),
        ),
    },
  };
  expect(await resolveLinkCard(context, pageUrl)).toMatchObject({
    title: "A title",
    imageUrl: null,
  });
  expect(testStorageObjects.size).toBe(1);
  await db.update(mediaIntent).set({ readyAt: new Date(0) });
  expect(await cleanupMediaIntents(db, testStorage)).toEqual({ completed: 1, failed: 0 });
  expect(testStorageObjects.size).toBe(0);
});
