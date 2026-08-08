/**
 * What the server will accept as a profile image, and where it stores it.
 *
 * Kept separate from `./storage.ts` because none of it is about object storage
 * — it is the rule for turning an untrusted upload into bytes we are willing to
 * serve back from our own origin, and it is pure, so it is testable without a
 * bucket.
 *
 * The client re-encodes every selected file through a canvas before uploading
 * (`apps/web/src/lib/media.ts`), which means a well-behaved upload is already
 * a small raster image. None of that is trusted here: a caller can post
 * anything to the procedure directly, so the declared MIME type is checked
 * against an allowlist AND against the file's own leading bytes.
 */
import { randomUUID } from "node:crypto";
import {
  ALLOWED_IMAGE_TYPES,
  IMAGE_LIMITS,
  MAX_IMAGE_MEGAPIXELS,
  MEDIA_URL_PREFIX,
  type AllowedImageType,
  type ImageKind,
} from "./constants.js";
import { imageDimensions } from "./dimensions.js";

/** Where each slot's objects live. The kind is the key's first segment. */
const KEY_PREFIX: Record<ImageKind, string> = {
  avatar: "avatars",
  banner: "banners",
};

/**
 * Which of the two objects an upload slot carries. The display object is what
 * feeds and profiles render; the original is the user's untouched file, kept
 * for a future crop/reposition editor. The two share a uuid and differ only in
 * the `.orig` infix, so the pair is obvious in the bucket.
 */
export type ImageVariant = "original" | "display";

const EXTENSION: Record<AllowedImageType, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};

/**
 * The leading bytes that actually identify each format, checked because a
 * `Content-Type` is whatever the caller typed. An SVG or an HTML document
 * renamed `.png` and declared `image/png` passes every other check in the
 * chain and would then be served back from our origin; this is what stops it.
 *
 * WebP is a RIFF container: bytes 0-3 are `RIFF`, 8-11 are `WEBP`, and the
 * four in between are a length, so the check has to skip them.
 */
const SIGNATURES: { type: AllowedImageType; test: (bytes: Uint8Array) => boolean }[] = [
  {
    type: "image/png",
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    type: "image/jpeg",
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: "image/webp",
    test: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

/** The format the bytes actually are, or `null` if they are none of the three. */
export function sniffImageType(bytes: Uint8Array): AllowedImageType | null {
  return SIGNATURES.find((signature) => signature.test(bytes))?.type ?? null;
}

/** Narrows an arbitrary string to an `AllowedImageType`. */
export function isAllowedImageType(value: string): value is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(value);
}

/** The reason codes `acceptImage` can refuse an upload with. */
export type ImageRejection = "type" | "size" | "content";

/** The verdict of `acceptImage`: accepted with the sniffed type, or refused with a reason. */
export interface ImageAcceptance {
  ok: boolean;
  reason?: ImageRejection;
  /** The sniffed type, which is what gets stored — never the declared one. */
  type?: AllowedImageType;
}

/**
 * Whether these bytes may be stored for this slot and variant.
 *
 * Returns a reason rather than throwing so the caller owns the error surface —
 * the procedure turns it into an `ORPCError` whose message the web app's
 * `localizeAuthError` can translate, and a test can assert on the reason
 * without matching prose.
 *
 * The size check runs before the signature check purely so a hostile 50 MB
 * upload is rejected on a cheap comparison. Both run regardless of what the
 * client claims.
 *
 * The dimension rule differs by variant because the two objects are served to
 * different audiences: an original is bounded by megapixels (a 20 MP flat
 * colour PNG is ~200 KB but a decompression bomb for whoever visits the
 * profile), while a display object must fit the slot's exact bounds, since it
 * is what lands in every feed.
 */
export function acceptImage(
  bytes: Uint8Array,
  declaredType: string,
  kind: ImageKind,
  variant: ImageVariant,
): ImageAcceptance {
  if (!isAllowedImageType(declaredType)) return { ok: false, reason: "type" };

  const cap =
    variant === "original"
      ? IMAGE_LIMITS[kind].maxOriginalBytes
      : IMAGE_LIMITS[kind].maxDisplayBytes;
  if (bytes.byteLength === 0 || bytes.byteLength > cap) return { ok: false, reason: "size" };

  const sniffed = sniffImageType(bytes);
  // A mismatch between the declared and actual type is a rejection, not a
  // silent correction: the two disagreeing means the upload is not what it
  // says it is, and storing it under the type we guessed would paper over
  // exactly the case this check exists to catch.
  if (!sniffed || sniffed !== declaredType) return { ok: false, reason: "content" };

  const dimensions = imageDimensions(bytes, sniffed);
  // A type that sniffs right but has no parseable header is not an image we
  // can size — and an unsized image is one we will not serve.
  if (!dimensions) return { ok: false, reason: "content" };

  if (variant === "original") {
    if (dimensions.width * dimensions.height > MAX_IMAGE_MEGAPIXELS * 1_000_000) {
      return { ok: false, reason: "size" };
    }
  } else {
    const { maxWidth, maxHeight } = IMAGE_LIMITS[kind];
    if (dimensions.width > maxWidth || dimensions.height > maxHeight) {
      return { ok: false, reason: "size" };
    }
  }

  return { ok: true, type: sniffed };
}

/**
 * A fresh, unguessable key for one upload object.
 *
 * The owner's id is in the path so objects are attributable and so the E2E
 * suite can delete a user's uploads by prefix — but it is never the *authority*
 * on who may write there. That is the session, checked in the procedure. A
 * uuid rather than the original filename because filenames are caller-supplied
 * and would let one upload overwrite another.
 *
 * The `id` parameter is what pairs the two objects of one upload: the
 * procedure mints ONE uuid and passes it to both calls, so the display and
 * original keys differ only in the `.orig` infix — `.../<uuid>.webp` and
 * `.../<uuid>.orig.jpg` — which is what lets a future reaper pair them and a
 * human read the bucket. Defaulted here so single-object callers (tests,
 * fixtures) keep working.
 */
export function imageObjectKey(
  kind: ImageKind,
  userId: string,
  type: AllowedImageType,
  variant: ImageVariant,
  id: string = randomUUID(),
): string {
  const infix = variant === "original" ? ".orig" : "";
  return `${KEY_PREFIX[kind]}/${userId}/${id}${infix}.${EXTENSION[type]}`;
}

/** The stored column value for an object key, e.g. `/media/avatars/<id>/<uuid>.webp`. */
export function mediaPathFor(key: string): string {
  return `${MEDIA_URL_PREFIX}${key}`;
}

/**
 * The object key behind a stored column value, or `null` when the value is not
 * one of ours.
 *
 * A `user.image` may equally hold an absolute URL an OAuth provider gave us, in
 * which case there is no object to delete and this correctly says so.
 */
export function objectKeyFromMediaPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(MEDIA_URL_PREFIX)) return null;
  const key = value.slice(MEDIA_URL_PREFIX.length);
  return isSafeObjectKey(key) ? key : null;
}

/**
 * The shape every key this app writes has, and the only shape `/media/` will
 * serve.
 *
 * This is the path-traversal guard for the media route: the segment after
 * `/media/` reaches the S3 client directly, so `..`, a leading slash, an
 * encoded separator or a stray query would all be the caller's to choose
 * without it. Anchored and explicit rather than a blocklist.
 *
 * The uuid is the grouped form, matching `randomUUID()`'s output — the old
 * `[a-f0-9-]{36}` also matched 36 hyphens, which is not a shape this app
 * writes. The optional `.orig` infix is the original's key (see
 * `imageObjectKey`).
 */
export function isSafeObjectKey(key: string): boolean {
  return /^(avatars|banners)\/[A-Za-z0-9_-]+\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.orig)?\.(webp|png|jpg)$/.test(
    key,
  );
}
