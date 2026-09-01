import {
  ALLOWED_IMAGE_TYPES,
  IMAGE_LIMITS,
  MAX_IMAGE_MEGAPIXELS,
  POST_ATTACHMENT_MAX_BYTES,
  POST_ATTACHMENT_MAX_HEIGHT,
  POST_ATTACHMENT_MAX_MEGAPIXELS,
  POST_ATTACHMENT_MAX_WIDTH,
  type ImageKind,
} from "@my-tuums/api/constants";
import { imageDimensions } from "@my-tuums/api/dimensions";
import { calculateDisplayLayout, ImageError, type Crop } from "@/lib/media-layout";
import { createAnimatedGifVariant } from "@/lib/gif-variant-client";

export {
  calculateCropFrame,
  calculateCropRect,
  calculateDisplayLayout,
  clampCrop,
  DEFAULT_CROP,
  ImageError,
  minCropScale,
  type Crop,
  type CropRect,
  type DisplayLayout,
  type ImageProblem,
  type ImageSize,
} from "@/lib/media-layout";

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

/**
 * WebP encode quality for the display variants whose only job is to render
 * small: feeds, headers and the profile frame never draw a banner above its
 * native pixels, so 0.85 — the usual knee, visually indistinguishable from 1.0
 * at these sizes for roughly a third of the bytes — holds.
 */
const DISPLAY_VARIANT_WEBP_QUALITY = 0.85;

/**
 * Avatars encode a notch higher because one surface reads them differently:
 * the profile page's full-size viewer (`ImageViewer`) scales this same object
 * toward the viewport, where the knee's blocking starts to show. Feeds still
 * downscale, so nothing else changes; the enlarged avatar ceiling
 * (`IMAGE_LIMITS.avatar`) absorbs the extra bytes.
 */
const AVATAR_DISPLAY_VARIANT_WEBP_QUALITY = 0.9;

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
 * always encoded 3:1 (see `calculateDisplayLayout`); how that composition is
 * framed on a profile — and how much of it survives at the widest and
 * narrowest viewports — is owned by `lib/banner-frame.ts`. The crop editor
 * separately outlines the source region this function will encode.
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

  if (file.type === "image/gif") {
    return createAnimatedGifVariant(file, {
      kind,
      crop,
      maxBytes: IMAGE_LIMITS[kind].maxDisplayBytes,
    });
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
    let blob: Blob;
    while (true) {
      // Assigning canvas dimensions clears the canvas, so the draw precedes
      // every encode attempt — including the retries below.
      // The retry loop below halves the canvas; the destination size scales
      // with it so a retried encode is the same composition, smaller — not the
      // original composition clipped to a corner. The destination origin is
      // always the canvas origin: the crop window is a region of the source
      // with nothing around it, so there is no offset to scale.
      const shrinkX = canvas.width / layout.width;
      const shrinkY = canvas.height / layout.height;
      context.drawImage(
        bitmap,
        layout.sourceX,
        layout.sourceY,
        layout.sourceWidth,
        layout.sourceHeight,
        0,
        0,
        layout.destinationWidth * shrinkX,
        layout.destinationHeight * shrinkY,
      );

      blob = await toBlob(
        canvas,
        kind === "avatar" ? AVATAR_DISPLAY_VARIANT_WEBP_QUALITY : DISPLAY_VARIANT_WEBP_QUALITY,
      );
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
 * Banners are always 3:1. The crop window is a region of the source: it can
 * zoom in from, and pan within, the default composition, but never leave it —
 * the default window already spans the source's full width or full height
 * (issue #273). The profile banner displays that one composition with its
 * height clamped (see `lib/banner-frame.ts`), so extreme viewports trim edges
 * of it rather than re-choosing the crop. The editor shows the whole source and
 * outlines this actual 3:1 crop before it is encoded.
 *
 * The math itself lives in `lib/media-layout.ts` — re-exported above — because
 * `lib/gif-variant-worker.ts` needs the identical `calculateDisplayLayout` a
 * GIF frame is cropped and scaled with, and a worker cannot import this
 * module (its top-level scope reaches for `document`).
 */

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

  if (file.type === "image/gif") {
    return createAnimatedGifVariant(file, {
      maxWidth: POST_ATTACHMENT_MAX_WIDTH,
      maxHeight: POST_ATTACHMENT_MAX_HEIGHT,
      maxBytes: POST_ATTACHMENT_MAX_BYTES,
    });
  }

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

      blob = await toBlob(canvas, DISPLAY_VARIANT_WEBP_QUALITY);
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

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new ImageError("decode"));
      },
      "image/webp",
      quality,
    );
  });
}
