import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_ACCEPT, ImageError, downscaleImage } from "@/lib/media";

/**
 * The guard paths only.
 *
 * The canvas half of `downscaleImage` is deliberately untested here: jsdom
 * implements neither `createImageBitmap` nor a real 2D context, so a test of the
 * resize arithmetic would be a test of whatever stub it installed rather than of
 * the browser behaviour it stands in for. That path is covered end to end by
 * `e2e/tests/specs/settings.spec.ts`, in a real browser, against a real bucket.
 *
 * What IS worth pinning here is everything that decides whether the canvas is
 * reached at all — and, more importantly, that a rejection is an `ImageError`
 * carrying a `problem`, because `atoms/profile-edit.ts` branches on exactly that
 * to choose between its own copy and passing a server message straight through.
 */

const originalCreateImageBitmap = globalThis.createImageBitmap;

afterEach(() => {
  globalThis.createImageBitmap = originalCreateImageBitmap;
});

function file(type: string, size = 16): File {
  return new File([new Uint8Array(size)], "pic", { type });
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

describe("downscaleImage", () => {
  it("rejects a type outside the allowlist without touching the decoder", async () => {
    const decode = vi.fn();
    globalThis.createImageBitmap = decode;

    await expect(downscaleImage(file("image/svg+xml"), "avatar")).rejects.toMatchObject({
      problem: "type",
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects a source far too large to decode, before decoding it", async () => {
    const decode = vi.fn();
    globalThis.createImageBitmap = decode;

    // Bounded well above the per-slot upload caps on purpose — downscaling is
    // what makes a phone photo an acceptable avatar, so rejecting at the
    // *upload* cap here would defeat the feature. This bound only stops the
    // decoder being handed something that would exhaust memory.
    await expect(
      downscaleImage(file("image/png", 26 * 1024 * 1024), "avatar"),
    ).rejects.toMatchObject({ problem: "size" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("reports 'decode' when the bytes cannot be decoded despite an allowed type", async () => {
    // `File.type` comes from the OS's extension mapping, not the bytes — this
    // is the case the type check structurally cannot catch.
    globalThis.createImageBitmap = vi.fn(() => Promise.reject(new Error("not an image")));

    await expect(downscaleImage(file("image/png"), "avatar")).rejects.toMatchObject({
      problem: "decode",
    });
  });

  it("throws ImageError, which is what profile-edit.ts branches on", async () => {
    await expect(downscaleImage(file("text/html"), "avatar")).rejects.toBeInstanceOf(ImageError);
  });
});
