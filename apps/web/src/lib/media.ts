import {
  ALLOWED_IMAGE_TYPES,
  BANNER_ASPECT_RATIO,
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
export async function validateImageFile(file: File, kind: ImageKind): Promise<void> {
  if (!isAllowedType(file.type)) throw new ImageError("type");
  if (file.size === 0 || file.size > IMAGE_LIMITS[kind].maxOriginalBytes) {
    throw new ImageError("size");
  }

  // Megapixel pre-check on header bytes, before any decode: a 400 MP
  // flat-colour PNG is ~200 KB and decodes to a gigabyte of pixels. The byte
  // cap above never sees it. This has to run before *any* caller decodes —
  // including the crop editor, which decodes to measure the source, so a bomb
  // would freeze the tab merely by being selected. The server enforces the
  // same ceiling on the original; rejecting here saves the browser the decode.
  // A file whose header is unparseable (a JPEG with a huge EXIF block pushes
  // the SOF past the first 64 bytes) simply skips the pre-check — the server
  // still holds the line.
  const header = await readFirstBytes(file, 64);
  const headerDims = header ? imageDimensions(header, file.type) : null;
  if (headerDims && headerDims.width * headerDims.height > MAX_IMAGE_MEGAPIXELS * 1_000_000) {
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
 * encoded at a canonical 3:1 (see `calculateDisplayLayout`), giving the crop
 * editor one stable source composition even though the profile frame remains
 * responsive and may hide edges with `object-cover`.
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
  await validateImageFile(file, kind);

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
 * With a `crop` (the editor's output) the layout uses the chosen region, never
 * upscaled — see the branch at the top. The two branches below are the no-crop
 * defaults.
 *
 * Avatars preserve the whole image (contain): the round frame's `object-cover`
 * already hides nothing worth keeping, so cropping at encode would only
 * permanently discard pixels a future refit wants.
 *
 * Banners are always 3:1. The profile banner remains a full-bleed responsive
 * box, so its `object-cover` display may crop the 3:1 source differently at
 * different viewports. The editor makes that tradeoff visible with a safe-area
 * overlay instead of pretending a source-dependent crop can be authoritative.
 */

/**
 * The crop a user chose in the editor: the visible region's center as a
 * fraction of the source (0..1), and a zoom where **1 shows the slot's default
 * crop**. Client-only — the crop is baked into the
 * display variant before upload, never sent to the server.
 */
export type Crop = { x: number; y: number; scale: number };

/** Pixel dimensions of an image or a region of one. */
export type ImageSize = { width: number; height: number };

/** The crop that changes nothing: what a slot encodes to when nobody adjusts it. */
export const DEFAULT_CROP: Crop = { x: 0.5, y: 0.5, scale: 1 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The region the editor frames at zoom 1 — deliberately the same rectangle the
 * no-crop path encodes, so applying without touching anything is a no-op.
 * Avatars preserve the whole source. Banners cover-crop to the canonical 3:1.
 */
export function calculateCropFrame(
  source: { width: number; height: number },
  kind: ImageKind,
): ImageSize {
  if (kind === "banner") {
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
  const layout = calculateDisplayLayout(source, kind);
  return { width: layout.sourceWidth, height: layout.sourceHeight };
}

/**
 * The source rectangle a crop selects.
 *
 * At `scale` 1 this is exactly `calculateCropFrame` — the whole of what would
 * have been encoded anyway. Zooming in shrinks the rect around
 * `crop.x`/`crop.y` (the center, as a fraction of the source), keeping the
 * frame's aspect so the preview and the encode agree. The rect is clamped
 * inside the source, so a center near an edge is pulled back rather than
 * producing a rectangle the canvas cannot draw.
 */
export type CropRect = { x: number; y: number; width: number; height: number };

export function calculateCropRect(
  source: { width: number; height: number },
  kind: ImageKind,
  crop: Crop,
): CropRect {
  const scale = Math.max(1, crop.scale);
  const frame = calculateCropFrame(source, kind);
  // Whole pixels throughout: `drawImage` samples a source rectangle, and the
  // no-crop path this must agree with at zoom 1 already rounds. A fractional
  // rect here would make the default crop differ from no crop at all by a
  // half-pixel, which is exactly the drift the zoom-1 test forbids.
  const width = Math.min(source.width, Math.round(frame.width / scale));
  const height = Math.min(source.height, Math.round(frame.height / scale));
  const x = Math.floor(clamp(crop.x * source.width - width / 2, 0, source.width - width));
  const y = Math.floor(clamp(crop.y * source.height - height / 2, 0, source.height - height));
  return { x, y, width, height };
}

/**
 * Clamps a crop descriptor so its rect stays inside the source: the center is
 * pulled back from the edges and the zoom is floored at 1. The editor calls
 * this after every pan/zoom so the descriptor it emits is always drawable.
 */
export function clampCrop(
  crop: Crop,
  source: { width: number; height: number },
  kind: ImageKind,
): Crop {
  const scale = Math.max(1, crop.scale);
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
    // The crop editor's output. `calculateCropRect` recurses into this function
    // WITHOUT a crop to find the frame, so this branch must never be reached
    // from there — it isn't, because that call omits `crop`.
    //
    // Both caps are honoured independently rather than assuming the rect has
    // the cap's aspect: at zoom 1 the rect is whatever the no-crop policy
    // picked (any aspect at all), so scaling on width alone could leave a tall
    // rect over the height cap and the server would reject the browser's own
    // variant. Never upscales.
    const rect = calculateCropRect(source, kind, crop);
    const scale = Math.min(maxWidth / rect.width, maxHeight / rect.height, 1);
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

  const frame = calculateCropFrame(source, kind);
  const sourceX = Math.floor((source.width - frame.width) / 2);
  const sourceY = Math.floor((source.height - frame.height) / 2);
  const scale = Math.min(maxWidth / frame.width, maxHeight / frame.height, 1);
  return {
    sourceX,
    sourceY,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    width: Math.max(1, Math.round(frame.width * scale)),
    height: Math.max(1, Math.round(frame.height * scale)),
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
