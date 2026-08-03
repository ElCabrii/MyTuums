import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_LIMITS } from "@my-tuums/api/constants";
import { IMAGE_ACCEPT, ImageError, createDisplayVariant } from "@/lib/media";

/**
 * The guard paths only.
 *
 * The canvas half of `createDisplayVariant` is deliberately untested here:
 * jsdom implements neither `createImageBitmap` nor a real 2D context, so a test
 * of the resize arithmetic would be a test of whatever stub it installed rather
 * than of the browser behaviour it stands in for. That path is covered end to
 * end by `e2e/tests/specs/settings.spec.ts`, in a real browser, against a real
 * bucket.
 *
 * What IS worth pinning here is everything that decides whether the canvas is
 * reached at all — and, more importantly, that a rejection is an `ImageError`
 * carrying a `problem`, because `atoms/profile-edit.ts` branches on exactly that
 * to choose between its own copy and passing a server message straight through.
 */

const originalCreateImageBitmap = globalThis.createImageBitmap;

afterEach(() => {
  globalThis.createImageBitmap = originalCreateImageBitmap;
  vi.restoreAllMocks();
});

function file(type: string, size = 16): File {
  return new File([new Uint8Array(size)], "pic", { type });
}

/** A file whose first bytes are a real PNG header declaring `dims`. */
function pngFileWithHeader(width: number, height: number): File {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
  ]);
  return new File([bytes], "pic.png", { type: "image/png" });
}

/**
 * Stubs the three browser primitives `createDisplayVariant` reaches for, so
 * the encode path can be exercised in jsdom (which implements none of them).
 */
function stubEncodePath({
  toBlob,
  width = 100,
  height = 100,
}: {
  toBlob: Blob;
  width?: number;
  height?: number;
}) {
  globalThis.createImageBitmap = vi.fn().mockResolvedValue({
    width,
    height,
    close: vi.fn(),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback: BlobCallback) => callback(toBlob),
  );
}

describe("IMAGE_ACCEPT", () => {
  it("offers exactly the types the server will accept, and never SVG", () => {
    // The file picker's `accept` and the server's allowlist come from the same
    // constant, so a picker that offered SVG would be advertising an upload
    // that is rejected after the round trip.
    expect(IMAGE_ACCEPT).toBe("image/webp,image/png,image/jpeg");
    expect(IMAGE_ACCEPT).not.toContain("svg");
  });
});

describe("createDisplayVariant", () => {
  it("rejects a type outside the allowlist without touching the decoder", async () => {
    const decode = vi.fn();
    globalThis.createImageBitmap = decode;

    await expect(createDisplayVariant(file("image/svg+xml"), "avatar")).rejects.toMatchObject({
      problem: "type",
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects a source over the slot's original cap, before decoding it", async () => {
    const decode = vi.fn();
    globalThis.createImageBitmap = decode;

    // The cap is what the original object is allowed to be; a file the browser
    // is about to read beyond it would be rejected as the original anyway.
    await expect(
      createDisplayVariant(file("image/png", IMAGE_LIMITS.avatar.maxOriginalBytes + 1), "avatar"),
    ).rejects.toMatchObject({ problem: "size" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects a megapixel bomb on header bytes alone, without decoding it", async () => {
    const decode = vi.fn();
    globalThis.createImageBitmap = decode;

    // 400 MP in 24 bytes: the byte cap never sees it, but the header parse
    // does — the browser should not pay for decoding a gigabyte of pixels it
    // is about to be told it may not upload.
    await expect(createDisplayVariant(pngFileWithHeader(20_000, 20_000), "avatar")).rejects.toMatchObject({
      problem: "size",
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it("reports 'decode' when the bytes cannot be decoded despite an allowed type", async () => {
    // `File.type` comes from the OS's extension mapping, not the bytes — this
    // is the case the type check structurally cannot catch.
    globalThis.createImageBitmap = vi.fn(() => Promise.reject(new Error("not an image")));

    await expect(createDisplayVariant(file("image/png"), "avatar")).rejects.toMatchObject({
      problem: "decode",
    });
  });

  it("throws ImageError, which is what profile-edit.ts branches on", async () => {
    await expect(createDisplayVariant(file("text/html"), "avatar")).rejects.toBeInstanceOf(ImageError);
  });

  it("declares the type the canvas actually produced, not webp by assertion", async () => {
    // `canvas.toBlob` falls back to PNG when WebP encode is unsupported —
    // silently. The returned File must carry the real type and extension,
    // or the server's declared-vs-actual sniff rejects a file the browser
    // itself just produced.
    stubEncodePath({ toBlob: new Blob([new Uint8Array(64)], { type: "image/png" }) });

    const encoded = await createDisplayVariant(file("image/png"), "avatar");

    expect(encoded.type).toBe("image/png");
    expect(encoded.name).toBe("avatar-display.png");
  });

  it("keeps webp when the canvas produced webp", async () => {
    stubEncodePath({ toBlob: new Blob([new Uint8Array(64)], { type: "image/webp" }) });

    const encoded = await createDisplayVariant(file("image/jpeg"), "avatar");

    expect(encoded.type).toBe("image/webp");
    expect(encoded.name).toBe("avatar-display.webp");
  });
});
