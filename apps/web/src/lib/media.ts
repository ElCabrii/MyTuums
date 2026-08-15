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
 * support) no larger than the slot's display bounds, preserving aspect ratio
 * and never scaling up.
 *
 * WebP because it is in `ALLOWED_IMAGE_TYPES`, is markedly smaller than PNG for
 * photographs, and is supported by every browser this app targets. `cover`-style
 * cropping is deliberately NOT done here — the avatar is displayed in a round
 * frame with `object-cover`, so cropping at encode time would permanently
 * discard pixels the display already hides.
 */
export async function createDisplayVariantImpl(file: File, kind: ImageKind): Promise<File> {
  if (!isAllowedType(file.type)) throw new ImageError("type");
  // The original's cap, not the display's: this is what we are willing to
  // *read* before shrinking, and it is also the cap the original object is
  // checked against server-side, so a file that passes here cannot be rejected
  // on bytes later.
  if (file.size === 0 || file.size > IMAGE_LIMITS[kind].maxOriginalBytes) {
    throw new ImageError("size");
  }

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
    const { maxWidth, maxHeight } = IMAGE_LIMITS[kind];
    // `min(..., 1)` is what stops a small image being blown up to the bounds,
    // which would add bytes and lose sharpness to gain nothing.
    //
    // The bitmap's dims, not the header's: `imageOrientation: "from-image"`
    // makes the decode already upright, so these are the display dims — which
    // is also what the canvas output's header will say, keeping the server's
    // display-bound check consistent with what actually renders. A rotated
    // phone photo is 3000x1000 in its header and 1000x3000 upright here; sizing
    // against the header would distort it.
    const scale = Math.min(maxWidth / bitmap.width, maxHeight / bitmap.height, 1);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) throw new ImageError("decode");
    context.drawImage(bitmap, 0, 0, width, height);

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
 * Live binding so test harnesses can substitute a no-op variant creator and
 * exercise upload flows without running the real image pipeline.
 */
export let createDisplayVariant: (file: File, kind: ImageKind) => Promise<File> =
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
