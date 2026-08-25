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
import { DEFAULT_SIGNED_URL_TTL, type Storage } from "./storage.js";

/** `url` is where the browser should go. */
export type MediaAuthorizer = (key: string, viewerId: string) => Promise<boolean>;

/**
 * Decides the Cache-Control a `/media/` redirect may carry for a key, or
 * `null` when its redirect must not be stored at all. Injected rather than
 * imported so this module stays generic over key conventions; see
 * `profileDisplayRedirectCacheControl` for the production policy.
 */
export type RedirectCachePolicy = (key: string) => string | null;

export type MediaResolver = (
  key: string,
  viewerId: string,
) => Promise<{ url: string; cacheControl?: string } | null>;

/**
 * `null` means "404 this" and is deliberately the answer to every failure
 * mode this function itself can produce — an unconfigured bucket, a malformed
 * key, a traversal attempt, a missing viewer, a denied authorization —
 * rather than distinguishing them in the response. A signed-in caller probing
 * `/media/` learns only whether an object exists, never why one doesn't.
 *
 * The viewer is load-bearing for EVERY key, profile media included: post
 * attachments need it for moderation/visibility, and profile keys need it so
 * a `.orig` original is only ever signed for its owner and a display object
 * only for a viewer who can see the owner (see
 * `./profile-media-authorization.ts`). `apps/server/src/request-handler.ts`
 * checks for a live session before the key is even parsed — an anonymous
 * caller gets a flat 401 and never learns anything about which keys are
 * well-formed — and only ever calls this with an authenticated viewer id.
 * This function itself stays a pure key→URL mapping with no opinion on who is
 * asking beyond what `authorize` decides; the session lives at the routing
 * layer, which is where it already had to check for `/rpc`.
 *
 * Note this does NOT check the object exists: presigning is a local signature
 * operation, so verifying would add a HEAD round trip to every image request
 * to turn a 403-from-the-bucket into a 404-from-us. The bucket answers that
 * question for free when the browser follows the redirect.
 */
export function createMediaResolver(
  storage: Storage | null,
  authorize?: MediaAuthorizer,
  redirectCachePolicy?: RedirectCachePolicy,
): MediaResolver {
  return async (key: string, viewerId: string) => {
    if (!storage) return null;
    if (!isSafeObjectKey(key)) return null;
    if (!viewerId || !authorize || !(await authorize(key, viewerId))) return null;
    const media: { url: string; cacheControl?: string } = {
      url: await storage.signedGetUrl(key, DEFAULT_SIGNED_URL_TTL),
    };
    // Set only when the policy grants it: an absent field reads as the
    // caller's no-store default, and no caller can mistake an undefined for
    // a decision.
    const cacheControl = redirectCachePolicy?.(key);
    if (cacheControl) media.cacheControl = cacheControl;
    return media;
  };
}
