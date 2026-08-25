import { randomUUID } from "node:crypto";
import { closeDb } from "@my-tuums/db";
import { user, userBlock } from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canViewProfileMedia } from "./profile-media-authorization.js";
import {
  anonContext,
  createTestUser,
  setUserBan,
  truncateAll,
  type TestUser,
} from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/**
 * Seats the row with a stored pair whose keys `isSafeObjectKey` accepts — the
 * same key shape `replaceProfileMedia` produces, without going through the
 * bucket. Returns the object keys, ready to be asked for.
 */
async function seedStoredPair(
  person: TestUser,
  kind: "avatar" | "banner",
  extensions: { display: "webp" | "gif"; original: "jpg" | "gif" } = {
    display: "webp",
    original: "jpg",
  },
): Promise<{ display: string; original: string }> {
  const id = randomUUID();
  const display = `${kind}s/${person.id}/${id}.${extensions.display}`;
  const original = `${kind}s/${person.id}/${id}.orig.${extensions.original}`;
  await anonContext.db
    .update(user)
    .set(
      kind === "avatar"
        ? { image: `/media/${display}`, imageOriginal: `/media/${original}` }
        : { bannerImage: `/media/${display}`, bannerImageOriginal: `/media/${original}` },
    )
    .where(eq(user.id, person.id));
  return { display, original };
}

describe("canViewProfileMedia", () => {
  it("lets the owner fetch both the display object and their private original", async () => {
    const owner = await createTestUser();
    const { display, original } = await seedStoredPair(owner, "avatar");

    expect(await canViewProfileMedia(anonContext.db, display, owner.id)).toBe(true);
    expect(await canViewProfileMedia(anonContext.db, original, owner.id)).toBe(true);
  });

  it("lets any viewer who can see the owner fetch the display object, but never the original", async () => {
    const owner = await createTestUser();
    const viewer = await createTestUser();
    const { display, original } = await seedStoredPair(owner, "avatar");

    expect(await canViewProfileMedia(anonContext.db, display, viewer.id)).toBe(true);
    // The untouched file is the owner's alone, even though the display object
    // renders for everyone.
    expect(await canViewProfileMedia(anonContext.db, original, viewer.id)).toBe(false);
  });

  it("authorizes GIF display and original keys under the same visibility rules", async () => {
    const owner = await createTestUser();
    const viewer = await createTestUser();
    const { display, original } = await seedStoredPair(owner, "avatar", {
      display: "gif",
      original: "gif",
    });

    expect(await canViewProfileMedia(anonContext.db, display, viewer.id)).toBe(true);
    expect(await canViewProfileMedia(anonContext.db, original, viewer.id)).toBe(false);
    expect(await canViewProfileMedia(anonContext.db, original, owner.id)).toBe(true);
  });

  it("applies the banner slot's columns rather than the avatar's", async () => {
    const owner = await createTestUser();
    const viewer = await createTestUser();
    await seedStoredPair(owner, "avatar");
    const { display, original } = await seedStoredPair(owner, "banner");

    expect(await canViewProfileMedia(anonContext.db, display, viewer.id)).toBe(true);
    expect(await canViewProfileMedia(anonContext.db, original, viewer.id)).toBe(false);
    expect(await canViewProfileMedia(anonContext.db, original, owner.id)).toBe(true);
  });

  it("hides the display object from a viewer the owner blocked", async () => {
    const owner = await createTestUser();
    const viewer = await createTestUser();
    const { display } = await seedStoredPair(owner, "avatar");
    await anonContext.db.insert(userBlock).values({ blockerId: owner.id, blockedId: viewer.id });

    expect(await canViewProfileMedia(anonContext.db, display, viewer.id)).toBe(false);
    // The owner still sees their own image; only the blocked viewer loses it.
    expect(await canViewProfileMedia(anonContext.db, display, owner.id)).toBe(true);
  });

  it("hides the display object from a viewer who blocked the owner", async () => {
    const owner = await createTestUser();
    const viewer = await createTestUser();
    const { display } = await seedStoredPair(owner, "avatar");
    await anonContext.db.insert(userBlock).values({ blockerId: viewer.id, blockedId: owner.id });

    expect(await canViewProfileMedia(anonContext.db, display, viewer.id)).toBe(false);
  });

  it("hides the display object behind an effective ban", async () => {
    const owner = await createTestUser();
    const viewer = await createTestUser();
    const { display } = await seedStoredPair(owner, "avatar");
    await setUserBan(owner.id, { reason: "test", expiresAt: null });

    expect(await canViewProfileMedia(anonContext.db, display, viewer.id)).toBe(false);
    // The owner still reaches their own media while serving a suspension.
    expect(await canViewProfileMedia(anonContext.db, display, owner.id)).toBe(true);
  });

  it("refuses a stale key once the slot points elsewhere", async () => {
    const owner = await createTestUser();
    const stale = await seedStoredPair(owner, "avatar");
    await seedStoredPair(owner, "avatar");

    // The row now references the second pair; the first pair's keys must not
    // resolve even for the owner.
    expect(await canViewProfileMedia(anonContext.db, stale.display, owner.id)).toBe(false);
    expect(await canViewProfileMedia(anonContext.db, stale.original, owner.id)).toBe(false);
  });

  it("refuses a key that parses as profile media but belongs to no user", async () => {
    const viewer = await createTestUser();
    expect(
      await canViewProfileMedia(
        anonContext.db,
        "avatars/no-such-user/11111111-1111-4111-8111-111111111111.webp",
        viewer.id,
      ),
    ).toBe(false);
  });

  it("refuses a malformed key outright — no query ever runs", async () => {
    const owner = await createTestUser();
    expect(await canViewProfileMedia(anonContext.db, "avatars/../../etc/passwd", owner.id)).toBe(
      false,
    );
    expect(
      await canViewProfileMedia(anonContext.db, "posts/owner-1/post-1/att-1.png", owner.id),
    ).toBe(false);
  });

  it("refuses the original when the owner does not match the key's owner segment", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const { original } = await seedStoredPair(owner, "avatar");

    expect(await canViewProfileMedia(anonContext.db, original, other.id)).toBe(false);
  });
});
