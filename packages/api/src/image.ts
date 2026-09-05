/**
 * What the server will accept as a profile image, and where it stores it.
 *
 * Kept separate from `./storage.ts` because none of it is about object storage
 * — it is the rule for turning an untrusted upload into bytes we are willing to
 * serve back from our own origin, and it is pure, so it is testable without a
 * bucket.
 *
 * The client re-encodes selected stills through a canvas and animated GIFs
 * through its frame-aware worker before uploading (`apps/web/src/lib/media.ts`),
 * which means a well-behaved upload is already a small raster image. None of
 * that is trusted here: a caller can post anything to the procedure directly,
 * so the declared MIME type is checked against an allowlist AND against the
 * file's own leading bytes.
 */
import { randomUUID } from "node:crypto";
import {
  IMAGE_LIMITS,
  MAX_IMAGE_MEGAPIXELS,
  MEDIA_URL_PREFIX,
  type AllowedImageType,
  type ImageKind,
} from "./constants.js";
import { imageDimensions } from "./dimensions.js";
import { isAllowedImageType, sniffImageType, type ImageRejection } from "./post-image.js";
import { gifFrameSummary, gifWithinLimits } from "./post-image-validation.js";

export {
  acceptPostImage,
  isAllowedImageType,
  sniffImageType,
  type ImageRejection,
  type PostImageAcceptance,
} from "./post-image.js";

/** Where each slot's objects live. The kind is the key's first segment. */
const KEY_PREFIX = {
  avatar: "avatars",
  banner: "banners",
} satisfies Record<ImageKind, string>;

/**
 * Which of the two objects an upload slot carries. The display object is what
 * feeds and profiles render; the original is the user's untouched file, kept
 * for a future crop/reposition editor. The two share a uuid and differ only in
 * the `.orig` infix, so the pair is obvious in the bucket.
 */
export type ImageVariant = "original" | "display";

/**
 * The file extension each allowed type is stored under. Exported for the
 * game-cover sync (`games-sync.ts`), which re-hosts external images under
 * the same extension convention — `jpeg` becoming `jpg` matters there: the
 * media key allowlist (`isSafeObjectKey`) names extensions, not MIME types.
 */
export const IMAGE_EXTENSION = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
} satisfies Record<AllowedImageType, string>;

const EXTENSION = IMAGE_EXTENSION;

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
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return { ok: false, reason: "content" };
  }

  // A GIF is also an animation: the same dimension header says nothing about
  // how many frames it carries or how much it decodes to. The block walk
  // validates the structure (a truncated GIF is `content`) and the limits
  // bound the work (an excessive-frame or decode-bomb GIF is `size`), the same
  // two verdicts `acceptPostImage` returns for a post attachment.
  if (sniffed === "image/gif") {
    const summary = gifFrameSummary(bytes);
    if (!summary) return { ok: false, reason: "content" };
    if (!gifWithinLimits(summary)) return { ok: false, reason: "size" };
  }

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
 * `imageObjectKey`), and the bare-uuid shape is a stored link preview's lead
 * image (see `link-card.ts`) — content this app mirrored, owned by no user.
 *
 * The optional `.w<N>.webp` suffix is a derived display variant (see
 * `MEDIA_VARIANT_WIDTHS` in ./constants.ts — structural only here; whether a
 * given width is one this app mints is `parseMediaVariantKey`'s to say).
 *
 * A game cover is `games/<igdbId>-<imageId>.<ext>` (issue #314): the IGDB id
 * of the game and IGDB's own image hash, so the key is content-addressed and
 * a repeat sync re-uploads exactly the same object — see `./game-media.ts`.
 */
export function isSafeObjectKey(key: string): boolean {
  return (
    /^(?:avatars|banners)\/[A-Za-z0-9_-]+\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.orig)?\.(webp|png|jpg|gif)(?:\.w\d+\.webp)?$/.test(
      key,
    ) ||
    /^posts\/[A-Za-z0-9_-]+\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(webp|png|jpg|gif)(?:\.w\d+\.webp)?$/.test(
      key,
    ) ||
    /^link-cards\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(webp|png|jpg|gif)(?:\.w\d+\.webp)?$/.test(
      key,
    ) ||
    /^games\/\d+-[a-z0-9]{2,64}\.(webp|png|jpg|gif)(?:\.w\d+\.webp)?$/.test(key)
  );
}
