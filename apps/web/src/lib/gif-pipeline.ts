import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { decompressFrames, parseGIF, type ParsedFrame, type ParsedGif } from "gifuct-js";
import {
  GIF_MAX_CUMULATIVE_PIXELS,
  GIF_MAX_FRAMES,
  GIF_MAX_TOTAL_DURATION_MS,
  type ImageKind,
} from "@my-tuums/api/constants";
import {
  calculateDisplayLayout,
  ImageError,
  type Crop,
  type DisplayLayout,
} from "@/lib/media-layout";

/**
 * Decode → composite → crop/scale → re-encode, for one animated GIF.
 *
 * `canvas.toBlob()` — what every other type in `lib/media.ts` re-encodes
 * through — exports a single still frame; it cannot be the animation path
 * (issue #201). This module is pure JS instead of canvas-based: no `document`,
 * no `OffscreenCanvas`, nothing DOM-only. That is what lets it run inside a
 * worker (`gif-variant-worker.ts`, off the main thread — a 500-frame,
 * 4096-square attachment would otherwise freeze the tab for the length of the
 * decode) AND be unit-tested in plain Node via an encode→decode round trip,
 * neither of which a canvas implementation could do.
 *
 * `gifuct-js` decodes; `gifenc` encodes. Both are pure JS with no native
 * bindings, chosen over `ImageDecoder` (Chromium/Firefox only, no compatible
 * fallback the issue asks for) and over piping through a canvas-based codec
 * (which would reintroduce the DOM dependency this module exists to avoid).
 */

/** Either profile slot's crop + bounds, or a post attachment's plain max-fit box. */
export type GifTarget =
  | { kind: ImageKind; crop?: Crop; maxBytes: number }
  | { maxWidth: number; maxHeight: number; maxBytes: number };

export interface AnimatedGifResult {
  bytes: Uint8Array;
  frameCount: number;
}

type GifFrameEntry = ParsedGif["frames"][number];
type GifImageFrameEntry = Extract<GifFrameEntry, { image: unknown }>;

function isImageFrame(frame: GifFrameEntry): frame is GifImageFrameEntry {
  return "image" in frame;
}

/**
 * The NETSCAPE2.0 application extension's loop count, or `-1` (gifenc's "play
 * once") when the source carries none. A source with no loop extension is not
 * "loop forever by default" — browsers play it once — so the re-encode must
 * reproduce absence, not default it to `0` (gifenc's "forever").
 *
 * The block's payload, after `js-binary-schema-parser` strips the sub-block
 * length prefixes, is `[loopSubBlockId, repeatLow, repeatHigh]`.
 */
function loopCount(parsed: ParsedGif): number {
  for (const frame of parsed.frames) {
    if (
      "application" in frame &&
      frame.application.id === "NETSCAPE2.0" &&
      frame.application.blocks.length >= 3
    ) {
      return frame.application.blocks[1] | (frame.application.blocks[2] << 8);
    }
  }
  return -1;
}

/**
 * Composites every decoded frame onto the full logical screen, honouring GIF
 * disposal semantics, and returns one full-canvas RGBA buffer per frame.
 *
 * Pre-compositing to full frames — rather than re-deriving each frame's visual
 * state at encode time — is what lets crop/scale run identically to the still
 * image path: `calculateDisplayLayout`'s source rect is defined in logical
 * screen space, and every composited frame here IS the logical screen, so the
 * same rect crops every one of them correctly regardless of a frame's own
 * (possibly much smaller) sub-rect.
 */
function compositeFrames(
  frames: ParsedFrame[],
  screen: { width: number; height: number },
): Array<{ data: Uint8ClampedArray; delay: number }> {
  const canvas = new Uint8ClampedArray(screen.width * screen.height * 4);
  const composited: Array<{ data: Uint8ClampedArray; delay: number }> = [];
  let previousState: Uint8ClampedArray | null = null;

  for (const frame of frames) {
    const disposal = frame.disposalType ?? 0;
    // Disposal applies AFTER this frame is shown, but "restore to previous"
    // restores what the canvas looked like BEFORE this frame was drawn, so the
    // snapshot has to be taken now.
    if (disposal === 3) previousState = canvas.slice();

    drawPatch(canvas, screen.width, frame);
    composited.push({ data: canvas.slice(), delay: frame.delay || 0 });

    if (disposal === 2) {
      clearRect(canvas, screen.width, frame.dims);
    } else if (disposal === 3 && previousState) {
      canvas.set(previousState);
    }
  }

  return composited;
}

/** Draws one frame's patch onto the shared canvas; a transparent source pixel leaves the canvas untouched. */
function drawPatch(canvas: Uint8ClampedArray, canvasWidth: number, frame: ParsedFrame): void {
  const { left, top, width, height } = frame.dims;
  const patch = frame.patch;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const srcIndex = (y * width + x) * 4;
      if (patch[srcIndex + 3] === 0) continue;
      const dstIndex = ((top + y) * canvasWidth + (left + x)) * 4;
      canvas[dstIndex] = patch[srcIndex];
      canvas[dstIndex + 1] = patch[srcIndex + 1];
      canvas[dstIndex + 2] = patch[srcIndex + 2];
      canvas[dstIndex + 3] = 255;
    }
  }
}

function clearRect(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  dims: { left: number; top: number; width: number; height: number },
): void {
  for (let y = 0; y < dims.height; y += 1) {
    for (let x = 0; x < dims.width; x += 1) {
      const index = ((dims.top + y) * canvasWidth + (dims.left + x)) * 4;
      canvas[index] = 0;
      canvas[index + 1] = 0;
      canvas[index + 2] = 0;
      canvas[index + 3] = 0;
    }
  }
}

/**
 * Crops `region` out of `source` and box-samples it down to `targetWidth` ×
 * `targetHeight`. At 1:1 (the common no-crop, no-downscale case) every output
 * box is exactly one source pixel, so this reduces to a plain copy — the same
 * "zoom 1 is a no-op" property `calculateCropRect` guarantees for the still
 * image path holds here too.
 */
function resampleRegion(
  source: Uint8ClampedArray,
  sourceWidth: number,
  region: { x: number; y: number; width: number; height: number },
  targetWidth: number,
  targetHeight: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const scaleX = region.width / targetWidth;
  const scaleY = region.height / targetHeight;

  for (let ty = 0; ty < targetHeight; ty += 1) {
    const sy0 = Math.floor(ty * scaleY);
    const sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) * scaleY));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const sx0 = Math.floor(tx * scaleX);
      const sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) * scaleX));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const index = ((region.y + sy) * sourceWidth + (region.x + sx)) * 4;
          r += source[index];
          g += source[index + 1];
          b += source[index + 2];
          a += source[index + 3];
          count += 1;
        }
      }

      const outIndex = (ty * targetWidth + tx) * 4;
      out[outIndex] = count ? r / count : 0;
      out[outIndex + 1] = count ? g / count : 0;
      out[outIndex + 2] = count ? b / count : 0;
      out[outIndex + 3] = count ? a / count : 0;
    }
  }

  return out;
}

function hasTransparency(rgba: Uint8ClampedArray): boolean {
  for (let index = 3; index < rgba.length; index += 4) {
    // GIF transparency is 1-bit: anything more than half-transparent is worth
    // spending a palette slot on, matching gifenc's own `oneBitAlpha` threshold.
    if (rgba[index] <= 127) return true;
  }
  return false;
}

/** The post-attachment layout: max-fit within bounds, no crop, never upscaled — mirrors `createPostAttachmentImpl`. */
function fitLayout(
  source: { width: number; height: number },
  maxWidth: number,
  maxHeight: number,
): DisplayLayout {
  const scale = Math.min(maxWidth / source.width, maxHeight / source.height, 1);
  return {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: source.width,
    sourceHeight: source.height,
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

export function processAnimatedGif(source: ArrayBuffer, target: GifTarget): AnimatedGifResult {
  const parsed = parseGIF(source);
  const screen = { width: parsed.lsd.width, height: parsed.lsd.height };

  // A cheap upper-bound guard BEFORE decompression: frame count and declared
  // descriptor rects are available from the raw parse, so a hostile GIF
  // claiming hundreds of full-canvas frames is refused before the worker
  // spends time LZW-decoding any of them. A frame's declared rect cannot
  // exceed the logical screen in a well-formed GIF, so `frames × screen area`
  // is a safe (if loose) stand-in for the exact per-frame sum checked below.
  const imageFrames = parsed.frames.filter(isImageFrame);
  if (imageFrames.length === 0) throw new ImageError("decode");
  if (screen.width === 0 || screen.height === 0) throw new ImageError("decode");
  for (const frame of imageFrames) {
    const { left, top, width, height } = frame.image.descriptor;
    if (
      width === 0 ||
      height === 0 ||
      left + width > screen.width ||
      top + height > screen.height
    ) {
      throw new ImageError("decode");
    }
  }
  if (imageFrames.length > GIF_MAX_FRAMES) throw new ImageError("size");
  if (imageFrames.length * screen.width * screen.height > GIF_MAX_CUMULATIVE_PIXELS) {
    throw new ImageError("size");
  }

  const frames = decompressFrames(parsed, true);
  if (frames.length === 0) throw new ImageError("decode");

  // The precise totals `gifWithinLimits` checks server-side, now from the
  // decoded frames' actual rects and delays.
  let cumulativePixels = 0;
  let totalDurationMs = 0;
  for (const frame of frames) {
    cumulativePixels += frame.dims.width * frame.dims.height;
    totalDurationMs += frame.delay || 0;
  }
  if (cumulativePixels > GIF_MAX_CUMULATIVE_PIXELS) throw new ImageError("size");
  if (totalDurationMs > GIF_MAX_TOTAL_DURATION_MS) throw new ImageError("size");

  const composited = compositeFrames(frames, screen);
  const layout =
    "kind" in target
      ? calculateDisplayLayout(screen, target.kind, target.crop)
      : fitLayout(screen, target.maxWidth, target.maxHeight);
  const region = {
    x: layout.sourceX,
    y: layout.sourceY,
    width: layout.sourceWidth,
    height: layout.sourceHeight,
  };
  const repeat = loopCount(parsed);

  const encoder = GIFEncoder();
  for (const frame of composited) {
    const resampled = resampleRegion(frame.data, screen.width, region, layout.width, layout.height);

    // Each encoded frame is the FULL composited canvas, not a delta, so the
    // decoder must clear before drawing the next one (`dispose: 2`) —
    // otherwise a pixel this source cleared via disposalType 2 (restore to
    // background) would incorrectly show the previous frame's leftover pixel
    // showing through, since a "do not dispose" decoder never clears it.
    if (hasTransparency(resampled)) {
      const palette = quantize(resampled, 256, {
        format: "rgba4444",
        oneBitAlpha: true,
        clearAlpha: true,
        clearAlphaColor: 0x00,
      });
      const index = applyPalette(resampled, palette, "rgba4444");
      // `clearAlpha` normalises every transparent pixel to the same RGBA
      // before quantizing, so they collapse onto one palette entry — there is
      // at most one alpha-0 slot to find.
      const transparentIndex = palette.findIndex((color) => color[3] === 0);
      encoder.writeFrame(index, layout.width, layout.height, {
        palette,
        delay: frame.delay,
        repeat,
        dispose: 2,
        transparent: transparentIndex >= 0,
        transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
      });
    } else {
      const palette = quantize(resampled, 256, { format: "rgb565" });
      const index = applyPalette(resampled, palette, "rgb565");
      encoder.writeFrame(index, layout.width, layout.height, {
        palette,
        delay: frame.delay,
        repeat,
        dispose: 2,
      });
    }
  }
  encoder.finish();

  const bytes = encoder.bytes();
  if (bytes.byteLength > target.maxBytes) throw new ImageError("size");

  return { bytes, frameCount: composited.length };
}
