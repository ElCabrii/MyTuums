import {
  ALLOWED_IMAGE_TYPES,
  IMAGE_LIMITS,
  type ImageKind,
} from "@my-tuums/api/constants";

/**
 * Turning a file someone picked into something worth uploading.
 *
 * Everything here runs in the browser, on purpose. Re-encoding server-side
 * would mean `sharp` and its platform-specific native binary in the server
 * image, for a job a canvas already does — and the canvas has a second property
 * that matters more than the saved dependency: whatever goes in, what comes out
 * is genuinely raster bytes the browser itself produced. A renamed HTML file or
 * a script-bearing SVG cannot survive the round trip.
 *
 * None of that is trusted by the server, which sniffs the magic bytes of
 * whatever actually arrives (`packages/api/src/image.ts`). This is the
 * cooperative path, not the security boundary.
 */

/** What the file picker should offer, as an `accept` attribute. */
export const IMAGE_ACCEPT = ALLOWED_IMAGE_TYPES.join(",");

export type ImageProblem = "type" | "size" | "decode";

export class ImageError extends Error {
  constructor(readonly problem: ImageProblem) {
    super(problem);
    this.name = "ImageError";
  }
}

/**
 * How large a file we are willing to *read* before downscaling.
 *
 * Separate from, and much larger than, the per-slot upload caps: the point of
 * downscaling is that a 12 MP phone photo becomes an acceptable avatar, so
 * rejecting it at its original size would defeat the feature. This bound exists
 * only so `createImageBitmap` is never handed something that would exhaust
 * memory before it can be shrunk.
 */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/**
 * Re-encodes `file` to a WebP (or a PNG on a browser without WebP encode
 * support) no larger than the slot's bounds, preserving aspect ratio and never
 * scaling up.
 *
 * WebP because it is in `ALLOWED_IMAGE_TYPES`, is markedly smaller than PNG for
 * photographs, and is supported by every browser this app targets. `cover`-style
 * cropping is deliberately NOT done here — the avatar is displayed in a round
 * frame with `object-cover`, so cropping at encode time would permanently
 * discard pixels the display already hides.
 */
export async function downscaleImage(file: File, kind: ImageKind): Promise<File> {
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    throw new ImageError("type");
  }
  if (file.size > MAX_SOURCE_BYTES) throw new ImageError("size");

  const bitmap = await decode(file);

  try {
    const { maxWidth, maxHeight } = IMAGE_LIMITS[kind];
    // `min(..., 1)` is what stops a small image being blown up to the bounds,
    // which would add bytes and lose sharpness to gain nothing.
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
    if (blob.size > IMAGE_LIMITS[kind].maxBytes) throw new ImageError("size");

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
    return new File([blob], `${kind}.${extension}`, { type });
  } finally {
    // Bitmaps hold decoded pixel data outside the JS heap; without this an
    // avatar preview loop would retain every image the user auditioned.
    bitmap.close();
  }
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
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
