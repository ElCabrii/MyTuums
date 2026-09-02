/**
 * On-demand display variants of stored media objects (the responsive-image
 * half of the media pipeline, 0.4.0).
 *
 * Every image this app has ever stored keeps its original bytes under an
 * immutable key, and uploads stay untouched by this module — a variant is
 * DERIVED, the first time some surface actually asks for that width, and
 * written back to the bucket under a sibling key (`…/uuid.png.w640.webp`) with
 * the same immutable caching as an upload. That is what fixes existing
 * content retroactively: the oversized seed photos and legacy avatars
 * already in the bucket gain small variants without a migration, and a
 * variant can never disagree with the bytes it derived from because the key
 * names the width it was resized to.
 *
 * Why server-side `sharp`, when the client already re-encodes uploads
 * (`apps/web/src/lib/media.ts`)? That pipeline bounds what a WELL-BEHAVED
 * upload weighs, and deliberately so — but it cannot touch what was uploaded
 * before it existed, and it cannot help a feed render an image smaller than
 * the one stored. Generation-on-read closes both, at the cost of this one
 * native dependency in the server image.
 *
 * Cost bounds worth restating: only the widths in `MEDIA_VARIANT_WIDTHS`
 * are derivable (`parseMediaVariantKey` refuses everything else), each
 * (object, width) pair is generated at most once per process thanks to the
 * existence cache, and a generation failure degrades to serving the base
 * object — a visitor never sees a broken image because sharp refused a file.
 */
import sharp from "sharp";
import { mediaVariantKey, parseMediaVariantKey } from "./constants.js";
import type { Storage } from "./storage.js";

/** Which WebP quality a derived variant is encoded at. */
const VARIANT_WEBP_QUALITY = 80;

/**
 * The (base, width) pairs this process has already resolved — either found
 * existing or generated. Exists so the HEAD round trip is paid once per
 * variant per deploy rather than once per request; bounded by
 * widths × referenced objects, which is small, and dropped wholesale whenever
 * an entry proves stale (a generation race or a base that vanished).
 */
const resolvedVariants = new Set<string>();

/** Ensures a variant object exists; returns the key the caller should presign. */
export async function ensureMediaVariant(
  storage: Storage,
  requested: { baseKey: string; width: number },
): Promise<string> {
  const variantKey = mediaVariantKey(requested.baseKey, requested.width);
  if (resolvedVariants.has(variantKey)) return variantKey;

  const existing = await storage.head(variantKey);
  if (existing) {
    resolvedVariants.add(variantKey);
    return variantKey;
  }

  const base = await storage.get(requested.baseKey);
  // The base vanished between the authorize step and here (its post was
  // deleted, its row swapped): serve nothing rather than presign a dead key —
  // 404 is the truthful answer the base itself would have given.
  if (!base) return "";

  // An animated GIF is skipped on purpose: resizing an animation decodes and
  // re-encodes every frame, which is exactly the unbounded work this module
  // exists to avoid on the read path. The original scales in the browser.
  if (base.contentType === "image/gif") return requested.baseKey;

  try {
    const bytes = await sharp(base.bytes)
      .rotate()
      .resize({ width: requested.width, withoutEnlargement: true })
      .webp({ quality: VARIANT_WEBP_QUALITY })
      .toBuffer();
    await storage.put(variantKey, bytes, "image/webp");
    resolvedVariants.add(variantKey);
    return variantKey;
  } catch (error) {
    // A base sharp cannot decode is a base whose variant can never exist;
    // serving the original is the graceful degradation for every other
    // failure (transient provider error included — the next miss retries).
    console.error("Failed to derive media variant; serving the original instead.", error);
    return requested.baseKey;
  }
}

/** Re-exported for the resolver's single import; see `constants.ts` for the widths. */
export { parseMediaVariantKey };
