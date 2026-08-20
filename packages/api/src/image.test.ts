import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS, RPC_MAX_BODY_BYTES } from "./constants.js";
import {
  acceptImage,
  imageObjectKey,
  isSafeObjectKey,
  mediaPathFor,
  objectKeyFromMediaPath,
  sniffImageType,
} from "./image.js";

/**
 * A unit suite, not an integration one — none of this touches Postgres or a
 * bucket, which is the point of `image.ts` being pure. See CONTEXT.md: a
 * `*.test.ts` must not import `@my-tuums/db`, and this file is careful to pull
 * only from `./image.js` and `./constants.js`.
 */

/**
 * Real leading bytes for each format, INCLUDING a parseable dimension header
 * (256x128 PNG, 400x300 JPEG, 512x256 WebP) — `acceptImage` reads dimensions
 * now, so a positive case needs them. Built byte-by-byte, not hand-padded,
 * so an offset shift fails loudly.
 */
const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x01,
  0x00, // width: 256
  0x00,
  0x00,
  0x00,
  0x80, // height: 128
]);
const JPEG = new Uint8Array([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0x00,
  0x10,
  0x4a,
  0x46,
  0x49,
  0x46,
  0x00,
  0x01,
  0x01,
  0x00,
  0x00,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00,
  0xff,
  0xc0,
  0x00,
  0x11,
  0x08, // SOF0
  0x01,
  0x2c, // height: 300
  0x01,
  0x90, // width: 400
]);
// The "VP8 " payload opens with a 3-byte frame tag; the start code follows it.
// See the layout note in `./dimensions.ts`.
const WEBP = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46,
  0x00,
  0x00,
  0x00,
  0x00,
  0x57,
  0x45,
  0x42,
  0x50,
  0x56,
  0x50,
  0x38,
  0x20,
  0x00,
  0x00,
  0x00,
  0x00, // "VP8 "
  0xb0,
  0x5f,
  0x00, // frame tag
  0x9d,
  0x01,
  0x2a, // start code
  0x00,
  0x02, // width: 512
  0x00,
  0x01, // height: 256
]);

/** A PNG header with caller-selected dimensions and a caller-selected payload size. */
function pngWithDimensions(width: number, height: number, size = 24): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(PNG.slice(0, 8));
  bytes.set(
    [(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff],
    16,
  );
  bytes.set(
    [(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff],
    20,
  );
  return bytes;
}

describe("sniffImageType", () => {
  it("identifies the allowed formats and nothing else", () => {
    const utf8 = (s: string) => new TextEncoder().encode(s);
    const cases = [
      ["png", PNG, "image/png"],
      ["jpeg", JPEG, "image/jpeg"],
      ["webp", WEBP, "image/webp"],
      // A document that can carry script is not an image, however it is labelled.
      ["svg", utf8('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), null],
      ["html", utf8("<!doctype html><script>"), null],
      // A four-byte RIFF prefix is the start of a WebP but carries none of the
      // bytes that identify one; the length guard is what stops this reading
      // undefined and comparing it.
      ["truncated riff", new Uint8Array([0x52, 0x49, 0x46, 0x46]), null],
      ["empty", new Uint8Array([]), null],
    ] as const;

    expect(cases.map(([label, bytes]) => [label, sniffImageType(bytes)])).toEqual(
      cases.map(([label, , expected]) => [label, expected]),
    );
  });
});

describe("acceptImage", () => {
  it("accepts a well-formed image and reports the sniffed type", () => {
    expect(acceptImage(PNG, "image/png", "avatar", "display")).toEqual({
      ok: true,
      type: "image/png",
    });
  });

  it("rejects a type that is not on the allowlist", () => {
    expect(acceptImage(PNG, "image/svg+xml", "avatar", "display")).toMatchObject({
      ok: false,
      reason: "type",
    });
    expect(acceptImage(PNG, "text/html", "avatar", "display")).toMatchObject({
      ok: false,
      reason: "type",
    });
  });

  it("rejects bytes whose content disagrees with the declared type", () => {
    // The whole point of sniffing: `image/png` is what the caller says, PNG is
    // not what the bytes are. Rejected rather than silently stored as JPEG.
    expect(acceptImage(JPEG, "image/png", "avatar", "display")).toMatchObject({
      ok: false,
      reason: "content",
    });
  });

  it("rejects an SVG payload even when it declares an allowed type", () => {
    const svg = new TextEncoder().encode("<svg onload=alert(1)>");
    expect(acceptImage(svg, "image/png", "avatar", "display")).toMatchObject({
      ok: false,
      reason: "content",
    });
  });

  it("rejects an empty body", () => {
    expect(acceptImage(new Uint8Array([]), "image/png", "avatar", "display")).toMatchObject({
      ok: false,
      reason: "size",
    });
  });

  it("rejects a signature-only header, whose dimensions cannot be read", () => {
    // The PNG magic with no IHDR after it: sniffs as PNG, but no parseable
    // dimensions — and an unsized image is one we will not serve.
    const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(acceptImage(truncated, "image/png", "avatar", "display")).toMatchObject({
      ok: false,
      reason: "content",
    });
  });

  it("enforces the per-slot display byte cap, which differs between avatar and banner", () => {
    const overAvatar = new Uint8Array(IMAGE_LIMITS.avatar.maxDisplayBytes + 1);
    overAvatar.set(PNG.slice(0, 8));

    expect(acceptImage(overAvatar, "image/png", "avatar", "display")).toMatchObject({
      ok: false,
      reason: "size",
    });
    // The same payload is under the banner's larger cap, so it passes there —
    // the caps are per slot, not one global number.
    expect(acceptImage(overAvatar, "image/png", "banner", "display")).toMatchObject({ ok: true });
  });

  it("rejects a display object beyond the slot's pixel bounds", () => {
    // The display object is what lands in every feed; a hostile client can
    // name a 600px-wide image "the avatar's display object" and expect it to
    // ride along. The bound is what stops it.
    const wide = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x00,
      0x00,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50,
      0x56,
      0x50,
      0x38,
      0x20,
      0x00,
      0x00,
      0x00,
      0x00, // "VP8 "
      0xb0,
      0x5f,
      0x00, // frame tag
      0x9d,
      0x01,
      0x2a, // start code
      0x58,
      0x02, // width: 600
      0x2c,
      0x01, // height: 300
    ]);

    expect(acceptImage(wide, "image/webp", "avatar", "display")).toMatchObject({
      ok: false,
      reason: "size",
    });
    // Same bytes are fine as the ORIGINAL, whose rule is megapixels, not
    // display bounds.
    expect(acceptImage(wide, "image/webp", "avatar", "original")).toMatchObject({ ok: true });
  });

  it("accepts the banner's enlarged display bounds and byte budget", () => {
    // A 3 MB 3000x1000 PNG is larger than the old 2 MB cap, so this catches
    // the client/server display-byte limit falling behind the new resolution.
    const fullResolution = pngWithDimensions(3000, 1000, 3 * 1024 * 1024);
    expect(acceptImage(fullResolution, "image/png", "banner", "display")).toMatchObject({
      ok: true,
    });

    expect(IMAGE_LIMITS.banner).toMatchObject({
      maxDisplayBytes: 8 * 1024 * 1024,
      maxWidth: 3000,
      maxHeight: 1000,
    });
    expect(
      acceptImage(pngWithDimensions(3001, 1000), "image/png", "banner", "display"),
    ).toMatchObject({
      ok: false,
      reason: "size",
    });
    expect(
      acceptImage(pngWithDimensions(3000, 1001), "image/png", "banner", "display"),
    ).toMatchObject({
      ok: false,
      reason: "size",
    });
  });

  it("rejects an original beyond the megapixel ceiling, even when its bytes are tiny", () => {
    // The byte cap does not bound pixels: a 20000x20000 flat-colour PNG is
    // ~200 KB and 400 MP. Build a PNG header declaring exactly that.
    const bomb = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52,
      0x4e,
      0x20,
      0x00,
      0x00, // width: 20000
      0x4e,
      0x20,
      0x00,
      0x00, // height: 20000
    ]);
    expect(bomb.byteLength).toBeLessThan(IMAGE_LIMITS.avatar.maxOriginalBytes);

    expect(acceptImage(bomb, "image/png", "avatar", "original")).toMatchObject({
      ok: false,
      reason: "size",
    });
  });
});

describe("RPC_MAX_BODY_BYTES", () => {
  it("clears the largest slot TOTAL — an upload carries both objects in one request", () => {
    // The bug this pins: the ceiling used to clear only the bigger *cap*, so a
    // max-size banner upload (8 MB original + 8 MB display) was refused by its
    // own limit. The request carries both objects, so the ceiling must clear
    // the slot's sum.
    for (const slot of Object.values(IMAGE_LIMITS)) {
      expect(RPC_MAX_BODY_BYTES).toBeGreaterThan(slot.maxOriginalBytes + slot.maxDisplayBytes);
    }
  });
});

describe("object keys", () => {
  it("puts the owner id in the path and a fresh uuid in the filename", () => {
    const a = imageObjectKey("avatar", "user-1", "image/webp", "display");
    const b = imageObjectKey("avatar", "user-1", "image/webp", "display");

    expect(a).toMatch(
      /^avatars\/user-1\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.webp$/,
    );
    // Never derived from the upload's filename, so one upload cannot overwrite
    // another — including someone else's.
    expect(a).not.toBe(b);
  });

  it("maps each kind to its own prefix and each type to its extension", () => {
    expect(imageObjectKey("banner", "u", "image/jpeg", "display")).toMatch(/^banners\/u\/.*\.jpg$/);
    expect(imageObjectKey("avatar", "u", "image/png", "display")).toMatch(/^avatars\/u\/.*\.png$/);
  });

  it("pairs display and original on the caller-supplied id, differing only in the infix", () => {
    // The PROCEDURE mints one uuid and passes it to both calls; the infix is
    // what tells the two apart. That pairing is what lets a future reaper
    // match them and a human read the bucket.
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const display = imageObjectKey("avatar", "user-1", "image/webp", "display", id);
    const original = imageObjectKey("avatar", "user-1", "image/jpeg", "original", id);

    expect(display).toBe(`avatars/user-1/${id}.webp`);
    expect(original).toBe(`avatars/user-1/${id}.orig.jpg`);
  });

  it("round-trips a key through the stored /media path", () => {
    const key = imageObjectKey("avatar", "user-1", "image/webp", "display");
    expect(objectKeyFromMediaPath(mediaPathFor(key))).toBe(key);
  });

  it("reports null for a provider URL, which is not ours to delete", () => {
    expect(objectKeyFromMediaPath("https://lh3.googleusercontent.com/a/abc")).toBeNull();
    expect(objectKeyFromMediaPath(null)).toBeNull();
    expect(objectKeyFromMediaPath("")).toBeNull();
  });
});

/**
 * This is the guard on the /media route, where the segment after the prefix
 * reaches the S3 client directly — so the table is the allowlist, read as one.
 */
describe("isSafeObjectKey", () => {
  const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  function expectKeys(cases: readonly (readonly [string, boolean])[]): void {
    expect(cases.map(([key]) => [key, isSafeObjectKey(key)])).toEqual(
      cases.map(([key, expected]) => [key, expected]),
    );
  }

  it("accepts the display and original shapes this app writes, under either prefix", () => {
    expectKeys([
      [`avatars/user-1/${UUID}.webp`, true],
      [`banners/user-1/${UUID}.jpg`, true],
      // The `.orig` infix is the original's key shape.
      [`avatars/user-1/${UUID}.orig.jpg`, true],
      [`banners/user-1/${UUID}.orig.webp`, true],
    ]);
  });

  it("rejects traversal, foreign prefixes, bad extensions and malformed uuids", () => {
    expectKeys([
      ["avatars/../../etc/passwd", false],
      ["../secrets/key.webp", false],
      [`/avatars/u/${UUID}.webp`, false],
      [`backups/u/${UUID}.webp`, false],
      [`avatars/u/${UUID}.svg`, false],
      [`avatars/u/${UUID}.html`, false],
      // The old `[a-f0-9-]{36}` also matched 36 hyphens; the shape must be the
      // grouped uuid `randomUUID()` actually produces.
      ["avatars/u/------------------------------------.webp", false],
      ["avatars/u/aaaaaaaaaaaabbbbccccdddd.orig.png", false],
    ]);
  });
});
