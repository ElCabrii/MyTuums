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
import type { Storage } from "./storage.js";

export type MediaResolver = (key: string) => Promise<string | null>;

/**
 * How long a presigned media URL stays valid.
 *
 * Comfortably longer than the 5 minutes the redirect itself is cached for, so
 * a browser replaying a cached 302 never lands on an already-expired URL — the
 * failure that would look like a randomly broken avatar and be near-impossible
 * to reproduce.
 */
const MEDIA_URL_TTL_SECONDS = 3600;

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
  return async (key: string): Promise<string | null> => {
    if (!storage) return null;
    if (!isSafeObjectKey(key)) return null;
    return storage.signedGetUrl(key, MEDIA_URL_TTL_SECONDS);
  };
}
