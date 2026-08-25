import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_LIMITS, POST_ATTACHMENT_MAX_BYTES } from "@my-tuums/api/constants";
import {
  IMAGE_ACCEPT,
  ImageError,
  calculateCropFrame,
  calculateCropRect,
  calculateDisplayLayout,
  clampCrop,
  createDisplayVariant,
  createPostAttachment,
} from "@/lib/media";

/**
 * The guard paths only.
 *
 * The canvas half of `createDisplayVariant` and `createPostAttachment` is
 * deliberately untested here: jsdom implements neither `createImageBitmap` nor
 * a real 2D context, so a test of the resize arithmetic would be a test of
 * whatever stub it installed rather than of the browser behaviour it stands in
 * for. That path is covered end to end by `e2e/tests/specs/settings.spec.ts`
 * and `e2e/tests/specs/compose.spec.ts`, in real browsers against a real
 * bucket.
 *
 * What IS worth pinning here is everything that decides whether the canvas is
 * reached at all — and, more importantly, that a rejection is an `ImageError`
 * carrying a `problem`, because `atoms/profile-edit.ts` branches on exactly
 * that to choose between its own copy and passing a server message straight
 * through.
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
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
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
  toBlob: Blob | Blob[];
  width?: number;
  height?: number;
}) {
  globalThis.createImageBitmap = vi.fn().mockResolvedValue({
    width,
    height,
    close: vi.fn(),
  });
  const contextDouble = {
    drawImage: vi.fn(() => {}),
  };
  // SAFETY: the encoder only reaches drawImage on the 2D context; the double
  // stands in for the full context type jsdom cannot construct.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => contextDouble as never,
  );
  const blobs = Array.isArray(toBlob) ? toBlob : [toBlob];
  let encodeIndex = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback: BlobCallback) => {
    callback(blobs[Math.min(encodeIndex, blobs.length - 1)] ?? null);
    encodeIndex += 1;
  });
  return contextDouble;
}

describe("IMAGE_ACCEPT", () => {
  it("offers exactly the types the server will accept, and never SVG", () => {
    // The file picker's `accept` and the server's allowlist come from the same
    // constant, so a picker that offered SVG would be advertising an upload
    // that is rejected after the round trip.
    expect(IMAGE_ACCEPT).toBe("image/webp,image/png,image/jpeg,image/gif");
    expect(IMAGE_ACCEPT).not.toContain("svg");
  });
});

describe("calculateCropFrame", () => {
  it("uses a square avatar composition for portrait and landscape sources", () => {
    expect(calculateCropFrame({ width: 400, height: 800 }, "avatar")).toEqual({
      width: 400,
      height: 400,
    });
    expect(calculateCropFrame({ width: 800, height: 400 }, "avatar")).toEqual({
      width: 400,
      height: 400,
    });
  });
});

describe("calculateCropRect", () => {
  // The crop editor's core: given source dims, a slot and a crop descriptor, it
  // picks the source rectangle the display variant is drawn from. Pinned here
  // because the editor's drag/zoom and the encoder's crop branch both build on
  // it.

  it("frames exactly what the no-crop path would keep, at zoom 1", () => {
    // THE load-bearing property: the default crop must select the same
    // rectangle `calculateDisplayLayout` picks with no crop at all. If these
    // ever diverge, merely opening the editor changes the stored image.
    const sources = [
      { width: 1200, height: 400 },
      { width: 1500, height: 500 },
      { width: 3840, height: 2160 },
      { width: 4000, height: 256 },
      { width: 1920, height: 256 },
      { width: 600, height: 600 },
      { width: 200, height: 200 },
      { width: 200, height: 400 },
    ];
    for (const kind of ["avatar", "banner"] as const) {
      for (const source of sources) {
        const bare = calculateDisplayLayout(source, kind);
        const rect = calculateCropRect(source, kind, { x: 0.5, y: 0.5, scale: 1 });
        expect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }).toEqual({
          x: bare.sourceX,
          y: bare.sourceY,
          width: bare.sourceWidth,
          height: bare.sourceHeight,
        });
      }
    }
  });

  it("zooms in by shrinking the rect around the center", () => {
    // A portrait avatar starts from its centered square; zoom 2 keeps the
    // middle half of that composition rather than reverting to source aspect.
    expect(
      calculateCropRect({ width: 400, height: 800 }, "avatar", { x: 0.5, y: 0.5, scale: 2 }),
    ).toEqual({ x: 100, y: 300, width: 200, height: 200 });
  });

  it("pans a square avatar composition within a portrait source", () => {
    expect(
      calculateCropRect({ width: 400, height: 800 }, "avatar", { x: 0.5, y: 0.25, scale: 1 }),
    ).toEqual({ x: 0, y: 0, width: 400, height: 400 });
  });

  it("clamps the rect to the source when the center is near an edge", () => {
    // A center at a corner would overhang; the rect is pulled back to the
    // source's edge rather than producing a rect the canvas cannot draw.
    expect(
      calculateCropRect({ width: 400, height: 400 }, "avatar", { x: 0, y: 0, scale: 2 }),
    ).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
    expect(
      calculateCropRect({ width: 400, height: 400 }, "avatar", { x: 1, y: 1, scale: 2 }),
    ).toEqual({
      x: 200,
      y: 200,
      width: 200,
      height: 200,
    });
  });

  it("never selects a rect outside the source, at any zoom or center", () => {
    const source = { width: 3840, height: 2160 };
    for (const kind of ["avatar", "banner"] as const) {
      for (const scale of [1, 1.5, 3, 8]) {
        for (const [x, y] of [
          [0, 0],
          [0.5, 0.5],
          [1, 1],
          [-2, 3],
        ]) {
          const rect = calculateCropRect(source, kind, { x, y, scale });
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.y).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.width).toBeLessThanOrEqual(source.width + 1e-9);
          expect(rect.y + rect.height).toBeLessThanOrEqual(source.height + 1e-9);
        }
      }
    }
  });
});

describe("clampCrop", () => {
  it("floors the zoom at 1 — below it there is nothing more to show", () => {
    expect(
      clampCrop({ x: 0.5, y: 0.5, scale: 0.2 }, { width: 400, height: 400 }, "avatar").scale,
    ).toBe(1);
  });

  it("pulls an off-source center back so the rect stays inside", () => {
    const source = { width: 400, height: 400 };
    const clamped = clampCrop({ x: 5, y: -5, scale: 2 }, source, "avatar");
    // At zoom 2 the rect is half the source, so the center cannot leave [.25,.75].
    expect(clamped.x).toBeCloseTo(0.75, 5);
    expect(clamped.y).toBeCloseTo(0.25, 5);
  });
});

describe("calculateDisplayLayout", () => {
  // The pure half of the encoder: given source dims and a slot, it picks the
  // source rectangle and output size with no canvas in the loop. That makes it
  // the right seam to pin the crop contract — the canvas path is untestable in
  // jsdom (see the file header) and covered end to end elsewhere, but the
  // arithmetic that decides sharpness is all here.

  it("avatar: center-crops to a square and never upscales", () => {
    // A 4000x4000 source is scaled down to the 512x512 cap, keeping every row.
    expect(calculateDisplayLayout({ width: 4000, height: 4000 }, "avatar")).toEqual({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 4000,
      sourceHeight: 4000,
      width: 512,
      height: 512,
    });
    // A source under the cap stays at native size — no invented pixels.
    expect(calculateDisplayLayout({ width: 100, height: 100 }, "avatar")).toEqual({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 100,
      sourceHeight: 100,
      width: 100,
      height: 100,
    });
    // A portrait keeps its full width and crops the same-sized square from the center.
    expect(calculateDisplayLayout({ width: 200, height: 400 }, "avatar")).toEqual({
      sourceX: 0,
      sourceY: 100,
      sourceWidth: 200,
      sourceHeight: 200,
      width: 200,
      height: 200,
    });
  });

  it("banner: center-crops every source to 3:1 without upscaling", () => {
    // A common landscape photo keeps its full width and crops height.
    expect(calculateDisplayLayout({ width: 3840, height: 2160 }, "banner")).toEqual({
      sourceX: 0,
      sourceY: 440,
      sourceWidth: 3840,
      sourceHeight: 1280,
      width: 3840,
      height: 1280,
    });
    // A source already at 3:1 is kept whole.
    expect(calculateDisplayLayout({ width: 1500, height: 500 }, "banner")).toEqual({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 1500,
      sourceHeight: 500,
      width: 1500,
      height: 500,
    });
    // A panorama keeps its full height and crops width to the same ratio.
    expect(calculateDisplayLayout({ width: 3840, height: 400 }, "banner")).toEqual({
      sourceX: 1320,
      sourceY: 0,
      sourceWidth: 1200,
      sourceHeight: 400,
      width: 1200,
      height: 400,
    });
    // A small square is cropped, but never enlarged.
    expect(calculateDisplayLayout({ width: 200, height: 200 }, "banner")).toEqual({
      sourceX: 0,
      sourceY: 66,
      sourceWidth: 200,
      sourceHeight: 67,
      width: 200,
      height: 67,
    });
  });

  it("banner: scales a large 3:1 crop within both display caps", () => {
    expect(calculateDisplayLayout({ width: 6000, height: 3000 }, "banner")).toEqual({
      sourceX: 0,
      sourceY: 500,
      sourceWidth: 6000,
      sourceHeight: 2000,
      width: 3840,
      height: 1280,
    });
  });

  it("crop: the default crop encodes exactly what no crop would have", () => {
    // Applying the editor without touching it must not change the image. The
    // Banner and avatar defaults have different policies, but both must agree
    // with what their editor shows at scale 1.
    for (const source of [
      { width: 200, height: 400 },
      { width: 1200, height: 400 },
      { width: 4000, height: 4000 },
      { width: 3840, height: 2160 },
      { width: 100, height: 100 },
    ]) {
      for (const kind of ["avatar", "banner"] as const) {
        expect(calculateDisplayLayout(source, kind, { x: 0.5, y: 0.5, scale: 1 })).toEqual(
          calculateDisplayLayout(source, kind),
        );
      }
    }
  });

  it("crop: zooming keeps the rect at native size rather than upscaling a sliver", () => {
    // A 3840x2160 banner frames 3840x1280 at zoom 1; zoom 2 halves that rect and
    // encodes it 1:1 — the output is the crop, never an upscale of it.
    expect(
      calculateDisplayLayout({ width: 3840, height: 2160 }, "banner", { x: 0.5, y: 0.5, scale: 2 }),
    ).toEqual({
      sourceX: 960,
      sourceY: 760,
      sourceWidth: 1920,
      sourceHeight: 640,
      width: 1920,
      height: 640,
    });
  });

  it("produces output the server's display-bound check will accept, for any source", () => {
    // The encoder's output is what `acceptImage(_, _, kind, "display")` sizes
    // against IMAGE_LIMITS, so width/height can never exceed the slot cap —
    // including after a center crop — or the server would reject the browser's
    // own variant. Checked across the awkward shapes, both slots.
    const cases = [
      { kind: "avatar" as const, src: { width: 4000, height: 4000 } },
      { kind: "avatar" as const, src: { width: 100, height: 100 } },
      { kind: "banner" as const, src: { width: 3840, height: 2160 } },
      { kind: "banner" as const, src: { width: 200, height: 200 } },
      { kind: "banner" as const, src: { width: 4000, height: 256 } },
      { kind: "banner" as const, src: { width: 5000, height: 3000 } },
      { kind: "banner" as const, src: { width: 600, height: 600 } },
      // The crop editor's output must clear the same bounds, including after a
      // zoom and an off-center pan.
      {
        kind: "avatar" as const,
        src: { width: 200, height: 400 },
        crop: { x: 0.5, y: 0.5, scale: 1 },
      },
      {
        kind: "avatar" as const,
        src: { width: 4000, height: 4000 },
        crop: { x: 0.25, y: 0.75, scale: 3 },
      },
      {
        kind: "banner" as const,
        src: { width: 3840, height: 2160 },
        crop: { x: 0.5, y: 0.5, scale: 2 },
      },
      {
        kind: "banner" as const,
        src: { width: 5000, height: 3000 },
        crop: { x: 0.1, y: 0.9, scale: 4 },
      },
    ];
    for (const { kind, src, crop } of cases) {
      const { width, height, sourceWidth, sourceHeight } = calculateDisplayLayout(src, kind, crop);
      const { maxWidth, maxHeight } = IMAGE_LIMITS[kind];
      expect(width).toBeLessThanOrEqual(maxWidth);
      expect(height).toBeLessThanOrEqual(maxHeight);
      // The drawn source rectangle stays inside the source.
      expect(sourceWidth).toBeLessThanOrEqual(src.width);
      expect(sourceHeight).toBeLessThanOrEqual(src.height);
    }
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
    await expect(
      createDisplayVariant(pngFileWithHeader(20_000, 20_000), "avatar"),
    ).rejects.toMatchObject({
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
    await expect(createDisplayVariant(file("text/html"), "avatar")).rejects.toBeInstanceOf(
      ImageError,
    );
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

  it("allows a photographic-sized PNG fallback for the full-resolution banner", async () => {
    // A browser without WebP encoding can produce a multi-megabyte PNG. This
    // is larger than the old 2 MB banner cap, but within the re-derived 8 MB.
    const size = 3 * 1024 * 1024;
    stubEncodePath({
      toBlob: new Blob([new Uint8Array(size)], { type: "image/png" }),
      width: 3840,
      height: 1280,
    });

    const encoded = await createDisplayVariant(file("image/jpeg"), "banner");

    expect(encoded.size).toBe(size);
    expect(encoded.type).toBe("image/png");
    expect(encoded.name).toBe("banner-display.png");
  });

  it("downscales an oversized PNG fallback until it fits the display byte cap", async () => {
    const context = stubEncodePath({
      toBlob: [
        new Blob([new Uint8Array(9 * 1024 * 1024)], { type: "image/png" }),
        new Blob([new Uint8Array(4 * 1024 * 1024)], { type: "image/png" }),
      ],
      width: 3840,
      height: 1280,
    });

    const encoded = await createDisplayVariant(file("image/jpeg"), "banner");

    expect(encoded.size).toBe(4 * 1024 * 1024);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(context.drawImage.mock.calls[1]?.slice(-2)).toEqual([1920, 640]);
  });

  it("keeps webp when the canvas produced webp", async () => {
    stubEncodePath({ toBlob: new Blob([new Uint8Array(64)], { type: "image/webp" }) });

    const encoded = await createDisplayVariant(file("image/jpeg"), "avatar");

    expect(encoded.type).toBe("image/webp");
    expect(encoded.name).toBe("avatar-display.webp");
  });
});

describe("createPostAttachment", () => {
  // The post pipeline shares its guards with the display variant, so only the
  // differences are re-pinned here: the attachment caps (not a slot's), and
  // the property that makes issue #207 hold — what comes back is the
  // encoder's output alone, never the picked bytes.

  it("rejects a type outside the allowlist without touching the decoder", async () => {
    const decode = vi.fn();
    globalThis.createImageBitmap = decode;

    await expect(createPostAttachment(file("image/svg+xml"))).rejects.toMatchObject({
      problem: "type",
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects a source over the attachment byte cap, before decoding it", async () => {
    const decode = vi.fn();
    globalThis.createImageBitmap = decode;

    await expect(
      createPostAttachment(file("image/png", POST_ATTACHMENT_MAX_BYTES + 1)),
    ).rejects.toMatchObject({ problem: "size" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects a megapixel bomb on header bytes alone, without decoding it", async () => {
    const decode = vi.fn();
    globalThis.createImageBitmap = decode;

    await expect(createPostAttachment(pngFileWithHeader(20_000, 20_000))).rejects.toMatchObject({
      problem: "size",
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it("uploads only canvas-produced bytes — the picked bytes never survive", async () => {
    // The mechanism behind metadata stripping: the stored File is assembled
    // from `canvas.toBlob`'s output and nothing else. A JPEG's EXIF block —
    // GPS included — lives in those input bytes, so if they do not reach the
    // output, no metadata does. The stubbed encoder here returns bytes that
    // share nothing with the source; jsdom cannot prove more, which is why
    // compose.spec.ts proves the same property end to end with real EXIF.
    const exifBytes = new Uint8Array(1024).fill(0xab);
    exifBytes.set([0xff, 0xd8, 0xff, 0xe1], 0); // JPEG SOI + APP1 marker
    exifBytes.set([...new TextEncoder().encode("Exif\0\0GPSProbe")], 6);
    const encodedBytes = new Uint8Array(64).fill(0x42);
    stubEncodePath({
      toBlob: new Blob([encodedBytes], { type: "image/webp" }),
      width: 800,
      height: 600,
    });

    const stored = await createPostAttachment(
      new File([exifBytes], "vacation.jpg", { type: "image/jpeg" }),
    );

    // jsdom's File has no arrayBuffer; FileReader is the one read path it
    // implements (the same reason `readFirstBytes` uses it).
    const storedBytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
        else reject(new Error("unreadable"));
      };
      reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
      reader.readAsArrayBuffer(stored);
    });

    expect(storedBytes).toEqual(encodedBytes);
    expect(stored.size).not.toBe(exifBytes.length);
    // The picker's name survives as a label; the declared type is the
    // encoder's truth.
    expect(stored.name).toBe("vacation.jpg");
    expect(stored.type).toBe("image/webp");
  });

  it("bounds past-cap dimensions and never upscales small sources", async () => {
    const context = stubEncodePath({
      toBlob: new Blob([new Uint8Array(64)], { type: "image/webp" }),
      width: 5000,
      height: 1000,
    });
    await createPostAttachment(file("image/png"));
    // scale = min(4096/5000, 4096/1000, 1) = 0.8192 → 4096 x 819.
    expect(context.drawImage.mock.calls[0]?.slice(-2)).toEqual([4096, 819]);

    const small = stubEncodePath({
      toBlob: new Blob([new Uint8Array(64)], { type: "image/webp" }),
      width: 100,
      height: 50,
    });
    await createPostAttachment(file("image/png"));
    expect(small.drawImage.mock.calls[0]?.slice(-2)).toEqual([100, 50]);
  });

  it("downscales an oversized PNG fallback until it fits the attachment cap", async () => {
    const context = stubEncodePath({
      toBlob: [
        new Blob([new Uint8Array(POST_ATTACHMENT_MAX_BYTES + 1)], { type: "image/png" }),
        new Blob([new Uint8Array(POST_ATTACHMENT_MAX_BYTES - 1)], { type: "image/png" }),
      ],
      width: 2048,
      height: 1024,
    });

    const stored = await createPostAttachment(file("image/png"));

    expect(stored.size).toBe(POST_ATTACHMENT_MAX_BYTES - 1);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(context.drawImage.mock.calls[1]?.slice(-2)).toEqual([1024, 512]);
  });
});
