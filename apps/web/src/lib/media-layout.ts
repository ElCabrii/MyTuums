import { BANNER_ASPECT_RATIO, IMAGE_LIMITS, type ImageKind } from "@my-tuums/api/constants";

/**
 * The pure crop/layout math shared by the canvas pipeline (`media.ts`) and the
 * GIF worker pipeline (`gif-pipeline.ts`).
 *
 * Split out because the worker cannot import `media.ts` itself: that module's
 * top-level scope reaches for `document.createElement` and `createImageBitmap`
 * at call time, which is fine on the main thread but pulls DOM-only types into
 * a module a worker bundle also needs. This file has no DOM dependency at all
 * — every function here takes plain `{ width, height }` records and returns
 * plain numbers, so it runs identically on the main thread and inside a
 * worker.
 */

/**
 * The crop a user chose in the editor: the visible region's center as a
 * fraction of the source (0..1), and a zoom where **1 shows the slot's default
 * crop**. Client-only — the crop is baked into the
 * display variant before upload, never sent to the server.
 *
 * The window never leaves the source: the default crop is the largest
 * aspect-true rectangle that fits, already spanning the source's full width or
 * its full height, so zoom only goes up from 1 and the center is clamped so
 * the window always sits over image pixels (issue #273).
 */
export type Crop = { x: number; y: number; scale: number };

/** Pixel dimensions of an image or a region of one. */
export type ImageSize = { width: number; height: number };

/** The crop that changes nothing: what a slot encodes to when nobody adjusts it. */
export const DEFAULT_CROP: Crop = { x: 0.5, y: 0.5, scale: 1 };

/**
 * The client-side reasons an upload can be refused before anything hits the
 * wire. Defined here, not in `media.ts`, so `gif-pipeline.ts` — which runs
 * inside a worker and must not pull in `media.ts`'s DOM-only canvas code —
 * can throw the same typed refusal the canvas path does.
 */
export type ImageProblem = "type" | "size" | "decode";

/** An upload refused by the client itself — carries a typed `problem` the UI can translate. */
export class ImageError extends Error {
  constructor(readonly problem: ImageProblem) {
    super(problem);
    this.name = "ImageError";
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The region the editor frames at zoom 1 — deliberately the same rectangle the
 * no-crop path encodes, so applying without touching anything is a no-op.
 * Avatars cover-crop to 1:1. Banners cover-crop to the canonical 3:1.
 */
export function calculateCropFrame(
  source: { width: number; height: number },
  kind: ImageKind,
): ImageSize {
  if (kind === "avatar") {
    const edge = Math.min(source.width, source.height);
    return { width: edge, height: edge };
  }

  const sourceAspect = source.width / source.height;
  if (sourceAspect > BANNER_ASPECT_RATIO) {
    return {
      width: Math.max(1, Math.round(source.height * BANNER_ASPECT_RATIO)),
      height: source.height,
    };
  }
  return {
    width: source.width,
    height: Math.max(1, Math.round(source.width / BANNER_ASPECT_RATIO)),
  };
}

/**
 * The lowest zoom a slot allows: the scale at which the window spans the
 * source's full width or its full height — its peak size, since growing past
 * that would push the window outside the source (issue #273). Both slots open
 * there, because `calculateCropFrame` picks the largest aspect-true rectangle
 * inside the source, which spans one axis exactly; the value is therefore 1
 * today but stays derived rather than restated, so a future frame change
 * cannot silently re-legalize a window the source cannot fill. This is both
 * the editor's wheel-zoom floor and the clamp every emitted crop is held to,
 * so the two can never disagree about what the minimum means.
 */
export function minCropScale(source: { width: number; height: number }, kind: ImageKind): number {
  const frame = calculateCropFrame(source, kind);
  return Math.max(frame.width / source.width, frame.height / source.height);
}

/**
 * The source rectangle a crop selects.
 *
 * At `scale` 1 this is exactly `calculateCropFrame` — the whole of what would
 * have been encoded anyway. Zooming in shrinks the rect around
 * `crop.x`/`crop.y` (the center, as a fraction of the source), keeping the
 * frame's aspect so the preview and the encode agree.
 *
 * The rect never leaves the source: its top-left is clamped to
 * [0, source − rect] on both axes, so every axis the window does not already
 * span is pan slack, and an axis it spans is pinned to the source's edge.
 */
export type CropRect = { x: number; y: number; width: number; height: number };

export function calculateCropRect(
  source: { width: number; height: number },
  kind: ImageKind,
  crop: Crop,
): CropRect {
  const scale = Math.max(minCropScale(source, kind), crop.scale);
  const frame = calculateCropFrame(source, kind);
  // Whole pixels throughout: `drawImage` samples a source rectangle, and the
  // no-crop path this must agree with at zoom 1 already rounds. A fractional
  // rect here would make the default crop differ from no crop at all by a
  // half-pixel, which is exactly the drift the zoom-1 test forbids.
  const width = Math.round(frame.width / scale);
  const height = Math.round(frame.height / scale);
  const x = Math.floor(clamp(crop.x * source.width - width / 2, 0, source.width - width));
  const y = Math.floor(clamp(crop.y * source.height - height / 2, 0, source.height - height));
  return { x, y, width, height };
}

/**
 * Clamps a crop descriptor so its window stays inside the source on both axes
 * and the zoom stays at or above the slot's floor. The editor calls this after
 * every pan/zoom so the descriptor it emits is always drawable.
 */
export function clampCrop(
  crop: Crop,
  source: { width: number; height: number },
  kind: ImageKind,
): Crop {
  const scale = Math.max(minCropScale(source, kind), crop.scale);
  const rect = calculateCropRect(source, kind, { ...crop, scale });
  const halfX = rect.width / (2 * source.width);
  const halfY = rect.height / (2 * source.height);
  return {
    x: clamp(crop.x, halfX, 1 - halfX),
    y: clamp(crop.y, halfY, 1 - halfY),
    scale,
  };
}

export type DisplayLayout = {
  /** The part of the source that is drawn — the crop window, always inside the bitmap. */
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Where that part lands on the output canvas. */
  destinationX: number;
  destinationY: number;
  destinationWidth: number;
  destinationHeight: number;
  width: number;
  height: number;
};

export function calculateDisplayLayout(
  source: { width: number; height: number },
  kind: ImageKind,
  crop?: Crop,
): DisplayLayout {
  const { maxWidth, maxHeight } = IMAGE_LIMITS[kind];

  if (crop) {
    // The crop editor's output. `calculateCropRect` recurses into this function
    // WITHOUT a crop to find the frame, so this branch must never be reached
    // from there — it isn't, because that call omits `crop`.
    //
    // Both caps are honoured independently, so changing a slot's dimensions
    // cannot make the browser produce a variant the server rejects. Never
    // upscales: the window is a region of the source, drawn once at 1:1 or
    // scaled down to fit the caps.
    const rect = calculateCropRect(source, kind, crop);
    const scale = Math.min(maxWidth / rect.width, maxHeight / rect.height, 1);
    // Rounded like the no-crop branch rounds, so a cover crop at zoom 1 is
    // byte-for-byte the layout no crop at all produces.
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    return {
      sourceX: rect.x,
      sourceY: rect.y,
      sourceWidth: rect.width,
      sourceHeight: rect.height,
      destinationX: 0,
      destinationY: 0,
      destinationWidth: width,
      destinationHeight: height,
      width,
      height,
    };
  }

  const frame = calculateCropFrame(source, kind);
  const sourceX = Math.floor((source.width - frame.width) / 2);
  const sourceY = Math.floor((source.height - frame.height) / 2);
  const scale = Math.min(maxWidth / frame.width, maxHeight / frame.height, 1);
  return {
    sourceX,
    sourceY,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    destinationX: 0,
    destinationY: 0,
    destinationWidth: Math.max(1, Math.round(frame.width * scale)),
    destinationHeight: Math.max(1, Math.round(frame.height * scale)),
    width: Math.max(1, Math.round(frame.width * scale)),
    height: Math.max(1, Math.round(frame.height * scale)),
  };
}
