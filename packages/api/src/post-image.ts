import {
  ALLOWED_IMAGE_TYPES,
  POST_ATTACHMENT_MAX_BYTES,
  POST_ATTACHMENT_MAX_HEIGHT,
  POST_ATTACHMENT_MAX_MEGAPIXELS,
  POST_ATTACHMENT_MAX_WIDTH,
  type AllowedImageType,
} from "./constants.js";
import { imageDimensions } from "./dimensions.js";
import { isStructurallyValidPostImage } from "./post-image-validation.js";

/** The reason codes shared by profile and post-image upload validation. */
export type ImageRejection = "type" | "size" | "content";

/** The server-owned verdict for one post attachment. */
export interface PostImageAcceptance {
  ok: boolean;
  reason?: ImageRejection;
  type?: AllowedImageType;
  width?: number;
  height?: number;
}

/**
 * The leading bytes that identify each supported format. The declared MIME
 * type is checked against this result; callers never get to choose the type
 * stored for an accepted attachment.
 */
const SIGNATURES: { type: AllowedImageType; test: (bytes: Uint8Array) => boolean }[] = [
  {
    type: "image/png",
    test: (bytes) =>
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a,
  },
  {
    type: "image/jpeg",
    test: (bytes) =>
      bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    type: "image/webp",
    test: (bytes) =>
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50,
  },
];

/** The format the bytes actually are, or `null` if they are none of the three. */
export function sniffImageType(bytes: Uint8Array): AllowedImageType | null {
  return SIGNATURES.find((signature) => signature.test(bytes))?.type ?? null;
}

/** Narrows an arbitrary string to an `AllowedImageType`. */
export function isAllowedImageType(value: string): value is AllowedImageType {
  return ALLOWED_IMAGE_TYPES.some((allowedType) => allowedType === value);
}

/**
 * Validates one post attachment from its actual bytes. The declared type is
 * checked against both the allowlist and the file signature; dimensions come
 * from the image header rather than a client-provided field.
 */
export function acceptPostImage(bytes: Uint8Array, declaredType: string): PostImageAcceptance {
  if (!isAllowedImageType(declaredType)) return { ok: false, reason: "type" };
  if (bytes.byteLength === 0 || bytes.byteLength > POST_ATTACHMENT_MAX_BYTES) {
    return { ok: false, reason: "size" };
  }

  const sniffed = sniffImageType(bytes);
  if (!sniffed || sniffed !== declaredType) return { ok: false, reason: "content" };
  if (!isStructurallyValidPostImage(bytes, sniffed)) {
    return { ok: false, reason: "content" };
  }

  const dimensions = imageDimensions(bytes, sniffed);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return { ok: false, reason: "content" };
  }
  if (
    dimensions.width > POST_ATTACHMENT_MAX_WIDTH ||
    dimensions.height > POST_ATTACHMENT_MAX_HEIGHT ||
    dimensions.width * dimensions.height > POST_ATTACHMENT_MAX_MEGAPIXELS * 1_000_000
  ) {
    return { ok: false, reason: "size" };
  }

  return { ok: true, type: sniffed, ...dimensions };
}
