import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS } from "./constants.js";
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
 * bucket, which is the point of `image.ts` being pure. See CLAUDE.md: a
 * `*.test.ts` must not import `@my-tuums/db`, and this file is careful to pull
 * only from `./image.js` and `./constants.js`.
 */

/** Real leading bytes for each format, padded out to a plausible body. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(32).fill(0)]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(32).fill(0)]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x00, 0x00, 0x00, 0x00, // length, skipped by the sniffer
  0x57, 0x45, 0x42, 0x50, // "WEBP"
  ...new Array<number>(32).fill(0),
]);

describe("sniffImageType", () => {
  it("identifies each allowed format from its leading bytes", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("returns null for an SVG, which is a document that can carry script", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(sniffImageType(svg)).toBeNull();
  });

  it("returns null for HTML dressed up as an image", () => {
    expect(sniffImageType(new TextEncoder().encode("<!doctype html><script>"))).toBeNull();
  });

  it("does not read past the end of a truncated header", () => {
    // A four-byte RIFF prefix is the start of a WebP but carries none of the
    // bytes that identify one; the length guard is what stops this reading
    // undefined and comparing it.
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});

describe("acceptImage", () => {
  it("accepts a well-formed image and reports the sniffed type", () => {
    expect(acceptImage(PNG, "image/png", "avatar")).toEqual({ ok: true, type: "image/png" });
  });

  it("rejects a type that is not on the allowlist", () => {
    expect(acceptImage(PNG, "image/svg+xml", "avatar")).toMatchObject({ ok: false, reason: "type" });
    expect(acceptImage(PNG, "text/html", "avatar")).toMatchObject({ ok: false, reason: "type" });
  });

  it("rejects bytes whose content disagrees with the declared type", () => {
    // The whole point of sniffing: `image/png` is what the caller says, PNG is
    // not what the bytes are. Rejected rather than silently stored as JPEG.
    expect(acceptImage(JPEG, "image/png", "avatar")).toMatchObject({
      ok: false,
      reason: "content",
    });
  });

  it("rejects an SVG payload even when it declares an allowed type", () => {
    const svg = new TextEncoder().encode("<svg onload=alert(1)>");
    expect(acceptImage(svg, "image/png", "avatar")).toMatchObject({
      ok: false,
      reason: "content",
    });
  });

  it("rejects an empty body", () => {
    expect(acceptImage(new Uint8Array([]), "image/png", "avatar")).toMatchObject({
      ok: false,
      reason: "size",
    });
  });

  it("enforces the per-slot byte cap, which differs between avatar and banner", () => {
    const overAvatar = new Uint8Array(IMAGE_LIMITS.avatar.maxBytes + 1);
    overAvatar.set(PNG.slice(0, 8));

    expect(acceptImage(overAvatar, "image/png", "avatar")).toMatchObject({
      ok: false,
      reason: "size",
    });
    // The same payload is under the banner's larger cap, so it passes there —
    // the caps are per slot, not one global number.
    expect(acceptImage(overAvatar, "image/png", "banner")).toMatchObject({ ok: true });
  });
});

describe("object keys", () => {
  it("puts the owner id in the path and a fresh uuid in the filename", () => {
    const a = imageObjectKey("avatar", "user-1", "image/webp");
    const b = imageObjectKey("avatar", "user-1", "image/webp");

    expect(a).toMatch(/^avatars\/user-1\/[a-f0-9-]{36}\.webp$/);
    // Never derived from the upload's filename, so one upload cannot overwrite
    // another — including someone else's.
    expect(a).not.toBe(b);
  });

  it("maps each kind to its own prefix and each type to its extension", () => {
    expect(imageObjectKey("banner", "u", "image/jpeg")).toMatch(/^banners\/u\/.*\.jpg$/);
    expect(imageObjectKey("avatar", "u", "image/png")).toMatch(/^avatars\/u\/.*\.png$/);
  });

  it("round-trips a key through the stored /media path", () => {
    const key = imageObjectKey("avatar", "user-1", "image/webp");
    expect(objectKeyFromMediaPath(mediaPathFor(key))).toBe(key);
  });

  it("reports null for a provider URL, which is not ours to delete", () => {
    expect(objectKeyFromMediaPath("https://lh3.googleusercontent.com/a/abc")).toBeNull();
    expect(objectKeyFromMediaPath(null)).toBeNull();
    expect(objectKeyFromMediaPath("")).toBeNull();
  });
});

describe("isSafeObjectKey", () => {
  it("accepts only the shape this app writes", () => {
    expect(isSafeObjectKey("avatars/user-1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp")).toBe(true);
    expect(isSafeObjectKey("banners/user-1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg")).toBe(true);
  });

  it("rejects traversal, absolute paths and foreign prefixes", () => {
    // This is the guard on the /media route, where the segment after the prefix
    // reaches the S3 client directly.
    expect(isSafeObjectKey("avatars/../../etc/passwd")).toBe(false);
    expect(isSafeObjectKey("../secrets/key.webp")).toBe(false);
    expect(isSafeObjectKey("/avatars/u/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp")).toBe(false);
    expect(isSafeObjectKey("backups/u/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp")).toBe(false);
  });

  it("rejects an extension outside the allowlist", () => {
    expect(isSafeObjectKey("avatars/u/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.svg")).toBe(false);
    expect(isSafeObjectKey("avatars/u/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.html")).toBe(false);
  });
});
