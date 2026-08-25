import {
  ALLOWED_IMAGE_TYPES,
  BANNER_ASPECT_RATIO,
  IMAGE_LIMITS,
  MAX_IMAGE_MEGAPIXELS,
  POST_ATTACHMENT_MAX_BYTES,
  POST_ATTACHMENT_MAX_HEIGHT,
  POST_ATTACHMENT_MAX_MEGAPIXELS,
  POST_ATTACHMENT_MAX_WIDTH,
  type ImageKind,
} from "@my-tuums/api/constants";
import { imageDimensions } from "@my-tuums/api/dimensions";

/**
 * Turning picked files into the objects one upload carries.
 *
 * Everything here runs in the browser, on purpose. Re-encoding server-side
 * would mean `sharp` and its platform-specific native binary in the server
 * image, for a job a canvas already does — and the canvas has a second property
 * that matters more than the saved dependency: whatever goes in, what comes out
 * is genuinely raster bytes the browser itself produced. A renamed HTML file or
 * a script-bearing SVG cannot survive the round trip.
 *
 * The two upload slots disagree about the ORIGINAL, and both are product
 * requirements:
 *
 * - A profile's original is uploaded untouched so a user can refit their
 *   picture later without having lost pixels; what feeds, headers and profiles
 *   render is the display variant this module produces beside it — a small
 *   WebP, so megabytes of original never travel down a timeline. That original
 *   keeps whatever metadata it arrived with, deliberately, behind
 *   profile-media authorization.
 * - A post attachment keeps NO original. Posts are feed-wide content served to
 *   any signed-in viewer, so the only object stored is the one this module
 *   re-encodes — and a canvas encode carries no metadata by construction: no
 *   EXIF block, no GPS coordinates, no camera info survive into the bytes we
 *   hold (issue #207).
 *
 * None of this is trusted by the server, which sniffs the magic bytes of
 * whatever actually arrives (`packages/api/src/image.ts`,
 * `packages/api/src/post-image.ts`). This is the cooperative path, not the
 * security boundary.
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
  await refuseBeforeDecode(file, IMAGE_LIMITS[kind].maxOriginalBytes, MAX_IMAGE_MEGAPIXELS);
}

/**
 * The pre-decode refusals shared by every upload slot: an allowlisted type, a
 * non-empty source within `maxBytes`, and — from header bytes alone, before
 * any decode — a megapixel ceiling.
 *
 * The megapixel check exists because a 400 MP flat-colour PNG is ~200 KB and
 * decodes to a gigabyte of pixels; the byte cap never sees it. It has to run
 * before *any* caller decodes — including the crop editor, which decodes to
 * measure the source, so a bomb would freeze the tab merely by being selected.
 * The server enforces the same ceilings; rejecting here saves the browser the
 * decode. A file whose header is unparseable (a JPEG with a huge EXIF block
 * pushes the SOF past the first 64 bytes) simply skips the pre-check — the
 * server still holds the line.
 */
async function refuseBeforeDecode(
  file: File,
  maxBytes: number,
  maxMegapixels: number,
): Promise<void> {
  if (!isAllowedType(file.type)) throw new ImageError("type");
  if (file.size === 0 || file.size > maxBytes) {
    throw new ImageError("size");
  }

  const header = await readFirstBytes(file, 64);
  const headerDims = header ? imageDimensions(header, file.type) : null;
  if (headerDims && headerDims.width * headerDims.height > maxMegapixels * 1_000_000) {
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
    let blob: Blob;
    while (true) {
      context.drawImage(
        bitmap,
        layout.sourceX,
        layout.sourceY,
        layout.sourceWidth,
        layout.sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );

      blob = await toBlob(canvas);
      if (blob.size <= IMAGE_LIMITS[kind].maxDisplayBytes) break;

      // Browsers without WebP encoding silently return lossless PNG. A noisy
      // 3840x1280 PNG can exceed the display byte cap even though its dimensions
      // are valid, so retry at half resolution. This preserves a 1920px-wide
      // sample on the first retry and guarantees progress for unusually large
      // fallbacks without raising the RPC/storage budget.
      if (blob.type !== "image/png" || (canvas.width === 1 && canvas.height === 1)) {
        throw new ImageError("size");
      }
      canvas.width = Math.max(1, Math.floor(canvas.width / 2));
      canvas.height = Math.max(1, Math.floor(canvas.height / 2));
    }

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
 * upscaled — see the branch at the top. Without one it uses the slot's
 * canonical centered composition.
 *
 * Avatars are always 1:1. Every avatar surface is square before applying its
 * round mask, so baking the chosen square into the display variant keeps the
 * editor and the rendered result on the same composition. The untouched
 * original remains available for a future refit.
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
    // Both caps are honoured independently, so changing a slot's dimensions
    // cannot make the browser produce a variant the server rejects. Never
    // upscales.
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

/**
 * Re-encodes a picked post attachment into the only object a post stores.
 *
 * Unlike the profile slots there is no original beside it: post attachments
 * are feed-wide content any signed-in viewer can fetch, so the stored bytes
 * are exactly what this returns — freshly encoded raster with no metadata by
 * construction (issue #207). A phone photo's EXIF block — GPS coordinates,
 * camera and device info, timestamps — never reaches storage, because a
 * canvas encode cannot reproduce metadata: it emits pixels and nothing else.
 *
 * The output honours the same bounds the server enforces on an accepted
 * attachment: never scaled up, at most 4096 px per side, and the byte loop
 * keeps shrinking until the result fits `POST_ATTACHMENT_MAX_BYTES`. WebP at
 * the display variant's quality; PNG where a browser lacks WebP encoding —
 * both alpha-capable, so a transparent PNG survives as transparency instead
 * of being flattened onto black by a JPEG step.
 *
 * The returned File keeps the picker's name: it is transient — the server
 * mints its own object key and never persists a filename — and keeping it
 * leaves the composer's preview labels stable across processing. The File's
 * `type`, not its name, is what tells the truth about the bytes.
 */
export async function createPostAttachmentImpl(file: File): Promise<File> {
  await refuseBeforeDecode(file, POST_ATTACHMENT_MAX_BYTES, POST_ATTACHMENT_MAX_MEGAPIXELS);

  const bitmap = await decode(file);

  try {
    const scale = Math.min(
      POST_ATTACHMENT_MAX_WIDTH / bitmap.width,
      POST_ATTACHMENT_MAX_HEIGHT / bitmap.height,
      1,
    );
    // Whole pixels throughout, floored at 1 and capped so rounding can never
    // push a side past the bound the server measures from the same header.
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new ImageError("decode");

    let blob: Blob;
    while (true) {
      // Assigning the dimensions clears the canvas, so redraw precedes every
      // encode attempt — including the retries below.
      canvas.width = width;
      canvas.height = height;
      context.drawImage(bitmap, 0, 0, width, height);

      blob = await toBlob(canvas);
      if (blob.size <= POST_ATTACHMENT_MAX_BYTES) break;

      // Browsers without WebP encoding silently return lossless PNG, whose
      // photographic sizes can exceed the cap despite valid dimensions.
      // Retry at half resolution — preserving progress toward the cap —
      // instead of refusing; 1x1 is where giving up is the honest answer.
      if (blob.type !== "image/png" || (width === 1 && height === 1)) {
        throw new ImageError("size");
      }
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
    }

    // Read the type off the result, never assert webp — `canvas.toBlob`
    // falls back to PNG silently when WebP encode is unsupported, and
    // labelling one as the other is exactly the declared-vs-actual mismatch
    // the server's sniffer rejects. Both types are in the allowlist; anything
    // else is not a File worth sending.
    const type = blob.type;
    if (type !== "image/webp" && type !== "image/png") throw new ImageError("decode");
    return new File([blob], file.name, { type });
  } finally {
    // Bitmaps hold decoded pixel data outside the JS heap; release it even
    // when an encode attempt fails mid-loop.
    bitmap.close();
  }
}

/**
 * Live binding so test harnesses can substitute a no-op attachment processor
 * and exercise composer flows without running the real image pipeline.
 */
export let createPostAttachment: (file: File) => Promise<File> = createPostAttachmentImpl;

/** Test seam: swaps the attachment processor the composer calls through. */
export function installTestPostAttachment<Processor>(processor: Processor): void {
  // SAFETY: test processors implement the (file) => Promise<File> contract
  // and resolve the upload object the composer forwards to the transport.
  createPostAttachment = processor as typeof createPostAttachment;
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
