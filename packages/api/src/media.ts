/**
 * The read side of uploaded images: turning a `/media/<key>` request into
 * something the browser can actually fetch.
 *
 * Railway buckets are private, so there is no URL to link to directly and no
 * option to make one. The server therefore hands out a short-lived presigned
 * URL and redirects to it, which costs no service egress — the bytes go
 * straight from the bucket to the browser — and keeps the value stored in the
 * database a stable path rather than a URL that expires.
 *
 * Separate from `./storage.ts` (which knows nothing about our key conventions)
 * and from `./image.ts` (which is pure and knows nothing about a bucket), so
 * `apps/server` can be handed one small function instead of assembling the two
 * itself.
 */
import { isSafeObjectKey } from "./image.js";
import {
  DEFAULT_SIGNED_URL_TTL,
  secondsUntilWindowEnd,
  type Storage,
} from "./storage.js";

/**
 * The read side of uploaded images: turning a `/media/<key>` request into
 * something the browser can actually fetch.
 *
 * `url` is where the browser should go; `cacheSeconds` is how long the redirect
 * may be cached, bounded by the signing window so a cached redirect never
 * outlives the signature it points at.
 */
export type MediaResolver = (
  key: string,
) => Promise<{ url: string; cacheSeconds: number } | null>;

/**
 * `null` means "404 this" and is deliberately the answer to every failure
 * mode — an unconfigured bucket, a malformed key, a traversal attempt — rather
 * than distinguishing them in the response. A caller probing `/media/` learns
 * only whether an object exists, which is what a public avatar URL already
 * tells them.
 *
 * Note this does NOT check the object exists: presigning is a local signature
 * operation, so verifying would add a HEAD round trip to every image request
 * to convert a 403-from-the-bucket into a 404-from-us. The bucket answers that
 * question for free when the browser follows the redirect.
 */
export function createMediaResolver(storage: Storage | null): MediaResolver {
  return async (key: string) => {
    if (!storage) return null;
    if (!isSafeObjectKey(key)) return null;
    return {
      url: await storage.signedGetUrl(key, DEFAULT_SIGNED_URL_TTL),
      // The URL stays byte-identical only until the signing window rolls (see
      // MEDIA_SIGNING_WINDOW_MS in ./storage.ts); past that the next request
      // signs a different one. Caching the redirect for the remainder of the
      // window is the longest cache that never serves a stale signature.
      cacheSeconds: secondsUntilWindowEnd(),
    };
  };
}
