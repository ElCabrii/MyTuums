import {
  ALLOWED_IMAGE_TYPES,
  IMAGE_LIMITS,
  MAX_IMAGE_MEGAPIXELS,
  type ImageKind,
} from "@my-tuums/api/constants";
import { imageDimensions } from "@my-tuums/api/dimensions";

/**
 * Turning a file someone picked into the two objects one upload carries.
 *
 * Everything here runs in the browser, on purpose. Re-encoding server-side
 * would mean `sharp` and its platform-specific native binary in the server
 * image, for a job a canvas already does — and the canvas has a second property
 * that matters more than the saved dependency: whatever goes in, what comes out
 * is genuinely raster bytes the browser itself produced. A renamed HTML file or
 * a script-bearing SVG cannot survive the round trip.
 *
 * The ORIGINAL is uploaded untouched — that is the product requirement: a user
 * should be able to refit their picture later without having lost pixels. It is
 * the display variant this module produces: a small WebP that feeds, headers
 * and profiles render, so megabytes of original never travel down a timeline.
 *
 * None of this is trusted by the server, which sniffs the magic bytes of
 * whatever actually arrives (`packages/api/src/image.ts`). This is the
 * cooperative path, not the security boundary.
 */

/** What the file picker should offer, as an `accept` attribute. */
export const IMAGE_ACCEPT = ALLOWED_IMAGE_TYPES.join(",");

/** The client-side reasons an upload can be refused before anything hits the wire. */
export type ImageProblem = "type" | "size" | "decode";

/** An upload refused by the client itself — carries a typed `problem` the UI can translate. */
export class ImageError extends Error {
  constructor(readonly problem: ImageProblem) {
    super(problem);
    this.name = "ImageError";
  }
}

function isAllowedType(type: string): boolean {
  return ALLOWED_IMAGE_TYPES.some((allowed) => allowed === type);
}

/**
 * The client-side refusals that can be decided before any decode: the type
 * must be in the allowlist and the original must be within the slot's byte cap.
 *
 * Extracted from `createDisplayVariantImpl` so the crop editor can refuse a
 * file before it ever opens — an SVG or an over-cap original has no crop worth
 * choosing, and showing the editor for it would only delay the same refusal.
 * The byte cap is the original's, not the display's: it is what we are willing
 * to *read* before shrinking, and it is also the cap the original object is
 * checked against server-side, so a file that passes here cannot be rejected
 * on bytes later.
 */
export function validateImageFile(file: File, kind: ImageKind): void {
  if (!isAllowedType(file.type)) throw new ImageError("type");
  if (file.size === 0 || file.size > IMAGE_LIMITS[kind].maxOriginalBytes) {
    throw new ImageError("size");
  }
}

/**
 * The first `max` bytes of a file, or `null` when the platform cannot read
 * them (some engines lack `File.prototype.arrayBuffer`, and a sliced blob even
 * more so — FileReader is the one path every engine implements).
 */
function readFirstBytes(file: File, max: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : null);
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, max));
  });
}

/**
 * Re-encodes `file` to a WebP (or a PNG on a browser without WebP encode
 * support) no larger than the slot's display bounds, never scaling up.
 *
 * WebP because it is in `ALLOWED_IMAGE_TYPES`, is markedly smaller than PNG for
 * photographs, and is supported by every browser this app targets. Banners are
 * width-priority (see `calculateDisplayLayout`): fitting the whole source into
 * the cap was height-limited for tall photos and left the full-bleed banner
 * starved of width, so the banner fills width first and center-crops only the
 * height the fixed frame hides.
 *
 * With a `crop` — what the editor in
 * `components/settings/image-crop-dialog.tsx` produces — the chosen region
 * replaces those defaults and is baked into these pixels. That is the whole of
 * how a crop persists: there is no crop column, and every surface that renders
 * the image reads this one object. The untouched original remains the source
 * of truth, so a later re-crop starts from the full picture rather than from
 * an already-cropped copy.
 */
export async function createDisplayVariantImpl(
  file: File,
  kind: ImageKind,
  crop?: Crop,
): Promise<File> {
  validateImageFile(file, kind);

  // Megapixel pre-check on header bytes, before any decode: a 400 MP
  // flat-colour PNG is ~200 KB and decodes to a gigabyte of pixels. The server
  // enforces the same ceiling on the original; rejecting here saves the
  // browser from paying for the decode. A file whose header is unparseable
  // (a JPEG with a huge EXIF block pushes the SOF past the first 64 bytes)
  // simply skips the pre-check — the server still holds the line.
  const header = await readFirstBytes(file, 64);
  const headerDims = header ? imageDimensions(header, file.type) : null;
  if (headerDims && headerDims.width * headerDims.height > MAX_IMAGE_MEGAPIXELS * 1_000_000) {
    throw new ImageError("size");
  }

  const bitmap = await decode(file);

  try {
    const layout = calculateDisplayLayout(
      { width: bitmap.width, height: bitmap.height },
      kind,
      crop,
    );

    const canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;

    const context = canvas.getContext("2d");
    if (!context) throw new ImageError("decode");
    context.drawImage(
      bitmap,
      layout.sourceX,
      layout.sourceY,
      layout.sourceWidth,
      layout.sourceHeight,
      0,
      0,
      layout.width,
      layout.height,
    );

    const blob = await toBlob(canvas);
    if (blob.size > IMAGE_LIMITS[kind].maxDisplayBytes) throw new ImageError("size");

    // `canvas.toBlob` falls back to `image/png` when WebP encode is
    // unsupported — silently, with no error — so the type must be read off the
    // result, never asserted. Labelling PNG bytes as WebP is exactly the
    // declared-vs-actual mismatch the server's sniffer rejects, and the user
    // would then see "that file doesn't look like an image" about a file the
    // browser itself just produced. Both types are in the allowlist; anything
    // else is not a File worth sending.
    const type = blob.type;
    if (type !== "image/webp" && type !== "image/png") throw new ImageError("decode");
    const extension = type === "image/webp" ? "webp" : "png";
    return new File([blob], `${kind}-display.${extension}`, { type });
  } finally {
    // Bitmaps hold decoded pixel data outside the JS heap; without this an
    // avatar preview loop would retain every image the user auditioned.
    bitmap.close();
  }
}

/**
 * Chooses the source rectangle and output size for one display variant.
 *
 * With a `crop` (the editor's output) the layout is a cover-crop of the chosen
 * rect to the slot's aspect, never upscaled — see the branch at the top. The
 * two branches below are the no-crop defaults.
 *
 * Avatars preserve the whole image (contain): the round frame's `object-cover`
 * already hides nothing worth keeping, so cropping at encode would only
 * permanently discard pixels a future refit wants.
 *
 * Banners are width-priority. The profile banner is a full-bleed `w-full` box
 * behind a fixed `h-48 sm:h-64` frame that `object-cover` fills, so width is
 * the dimension the display is starved of and height is the one the frame
 * throws away. The layout fills width up to the cap (never upscaling) and crops
 * height to the cap, centered, only when the source is tall enough to exceed
 * it — the top/bottom dropped are exactly what `object-cover` hides. Width is
 * never cropped: a wider viewport can always use more width, and a source that
 * already fits the cap is kept whole so `object-cover` samples every pixel
 * rather than an upscaled sliver. This is a strict improvement over the old
 * contain fit, which was height-limited for tall sources and left width short.
 */

/**
 * The crop a user chose in the editor: the visible region's center as a
 * fraction of the source (0..1) and a zoom, where 1 is the largest rect of the
 * slot's aspect that fits the source. Client-only — the crop is baked into the
 * display variant before upload, never sent to the server.
 */
export type Crop = { x: number; y: number; scale: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The source rectangle a cover-crop of `aspect` selects, given a crop
 * descriptor.
 *
 * `crop.x`/`crop.y` are the crop's center as a fraction of the source (0..1);
 * `crop.scale` is the zoom, where 1 is the largest rect of `aspect` that fits
 * the source. The result is clamped so the rect never leaves the source — a
 * center near an edge, or a zoom that would overhang, is pulled back rather
 * than producing a rect the canvas cannot draw.
 */
export type CropRect = { x: number; y: number; width: number; height: number };

export function calculateCropRect(
  source: { width: number; height: number },
  aspect: number,
  crop: Crop,
): CropRect {
  const scale = Math.max(1, crop.scale);
  const coverWidth = Math.min(source.width, source.height * aspect);
  const coverHeight = Math.min(source.height, source.width / aspect);
  const width = coverWidth / scale;
  const height = coverHeight / scale;
  const x = clamp(crop.x * source.width - width / 2, 0, source.width - width);
  const y = clamp(crop.y * source.height - height / 2, 0, source.height - height);
  return { x, y, width, height };
}

/**
 * Clamps a crop descriptor so its rect stays inside the source: the center is
 * pulled back from the edges and the zoom is floored at 1 (never below the
 * cover rect). The editor calls this after every pan/zoom so the descriptor it
 * emits is always drawable, and `calculateCropRect` never has to overhang.
 */
export function clampCrop(
  crop: Crop,
  source: { width: number; height: number },
  aspect: number,
): Crop {
  const scale = Math.max(1, crop.scale);
  const coverWidth = Math.min(source.width, source.height * aspect);
  const coverHeight = Math.min(source.height, source.width / aspect);
  const width = coverWidth / scale;
  const height = coverHeight / scale;
  const minX = width / (2 * source.width);
  const minY = height / (2 * source.height);
  return {
    x: clamp(crop.x, minX, 1 - minX),
    y: clamp(crop.y, minY, 1 - minY),
    scale,
  };
}

export type DisplayLayout = {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
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
    // The crop editor's output: the chosen rect, cover-cropped to the slot's
    // aspect, never upscaled. `rect` already has the slot's aspect, so
    // `maxWidth / rect.width === maxHeight / rect.height` and one `min` is the
    // whole scale decision.
    const rect = calculateCropRect(source, maxWidth / maxHeight, crop);
    const scale = Math.min(maxWidth / rect.width, 1);
    return {
      sourceX: rect.x,
      sourceY: rect.y,
      sourceWidth: rect.width,
      sourceHeight: rect.height,
      width: Math.max(1, Math.round(rect.width * scale)),
      height: Math.max(1, Math.round(rect.height * scale)),
    };
  }

  if (kind === "avatar") {
    // `min(..., 1)` stops a small image being blown up to the bounds, which
    // would add bytes and lose sharpness to gain nothing.
    const scale = Math.min(maxWidth / source.width, maxHeight / source.height, 1);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));

    return {
      sourceX: 0,
      sourceY: 0,
      sourceWidth: source.width,
      sourceHeight: source.height,
      width,
      height,
    };
  }

  // Fill width up to the cap; never upscale, never crop width.
  const scale = Math.min(maxWidth / source.width, 1);
  const width = Math.max(1, Math.round(source.width * scale));
  const drawnHeight = source.height * scale;

  if (drawnHeight <= maxHeight) {
    // The source fits the cap's height at this width — contain, no crop.
    return {
      sourceX: 0,
      sourceY: 0,
      sourceWidth: source.width,
      sourceHeight: source.height,
      width,
      height: Math.max(1, Math.round(drawnHeight)),
    };
  }

  // Too tall: keep the full (scaled) width and crop height to the cap,
  // centered. `maxHeight / scale` is the source rows that map to `maxHeight`
  // after the width fill — everything outside them is what the frame hides.
  const sourceHeight = Math.round(maxHeight / scale);
  return {
    sourceX: 0,
    sourceY: Math.floor((source.height - sourceHeight) / 2),
    sourceWidth: source.width,
    sourceHeight,
    width,
    height: maxHeight,
  };
}

/**
 * Live binding so test harnesses can substitute a no-op variant creator and
 * exercise upload flows without running the real image pipeline.
 */
export let createDisplayVariant: (file: File, kind: ImageKind, crop?: Crop) => Promise<File> =
  createDisplayVariantImpl;

/** Test seam: swaps the variant creator the upload atoms call through. */
export function installTestDisplayVariant<Creator>(creator: Creator): void {
  // SAFETY: test creators implement the (file, kind) contract and resolve the
  // display upload object the atoms forward to the transport boundary.
  createDisplayVariant = creator as typeof createDisplayVariant;
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    // `imageOrientation` passed explicitly rather than left to the default:
    // the spec's default changed from "none" to "from-image" mid-flight and
    // browsers moved at different times. Implicit, a portrait phone photo
    // renders sideways on some browsers — and, worse, would disagree with the
    // untouched original, which an `<img>` always renders upright.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // A file that claims to be an image and cannot be decoded is the exact
    // case the type check above cannot catch, since `File.type` comes from the
    // OS's extension mapping rather than the bytes.
    throw new ImageError("decode");
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new ImageError("decode"));
      },
      "image/webp",
      // 0.85 is the usual knee for WebP: visually indistinguishable from 1.0 at
      // these sizes, roughly a third of the bytes.
      0.85,
    );
  });
}
