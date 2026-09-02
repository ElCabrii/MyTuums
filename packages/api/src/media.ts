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
import { ensureMediaVariant, parseMediaVariantKey } from "./media-variants.js";
import { DEFAULT_SIGNED_URL_TTL, type Storage } from "./storage.js";

/**
 * `url` is where the browser should go. `viewerId` is `null` for the
 * anonymous post-permalink reader (0.4.0) — whether that reader may see a
 * key is entirely `authorize`'s decision, and every authorizer has a
 * documented null-viewer rule.
 */
export type MediaAuthorizer = (key: string, viewerId: string | null) => Promise<boolean>;

/**
 * Decides the Cache-Control a `/media/` redirect may carry for a key, or
 * `null` when its redirect must not be stored at all. Injected rather than
 * imported so this module stays generic over key conventions; see
 * `profileDisplayRedirectCacheControl` for the production policy.
 */
export type RedirectCachePolicy = (key: string) => string | null;

export type MediaResolver = (
  key: string,
  viewerId: string | null,
) => Promise<{ url: string; cacheControl?: string } | null>;

/**
 * `null` means "404 this" and is deliberately the answer to every failure
 * mode this function itself can produce — an unconfigured bucket, a malformed
 * key, a traversal attempt, a denied authorization — rather than
 * distinguishing them in the response. A caller probing `/media/` learns only
 * whether an object exists, never why one doesn't.
 *
 * The viewer is load-bearing for every key EXCEPT the public read surface:
 * post attachments need the viewer for moderation/visibility, and profile
 * keys need it so a `.orig` original is only ever signed for its owner and a
 * display object only for a viewer who can see the owner (see
 * `./profile-media-authorization.ts`). An anonymous caller — the public post
 * permalink and the media it renders — is routed through the same authorizers
 * with a null viewer, which keep the owner-only rules owner-only.
 *
 * A key carrying a variant marker (`…/uuid.png.w640.webp`, see
 * `./media-variants.ts`) is authorized against its BASE key — the one the
 * database rows store, and therefore the one whose visibility decides — after
 * which the variant object is generated on first request and presigned
 * instead. A key with no marker is served exactly as before.
 *
 * Note this does NOT check the BASE object exists: presigning is a local
 * signature operation, so verifying would add a round trip to every image
 * request to turn a 403-from-the-bucket into a 404-from-us. The bucket
 * answers that question for free when the browser follows the redirect.
 */
export function createMediaResolver(
  storage: Storage | null,
  authorize?: MediaAuthorizer,
  redirectCachePolicy?: RedirectCachePolicy,
): MediaResolver {
  return async (key: string, viewerId: string | null) => {
    if (!storage) return null;
    if (!isSafeObjectKey(key)) return null;

    const variant = parseMediaVariantKey(key);
    const authorizedKey = variant?.baseKey ?? key;
    if (!authorize || !(await authorize(authorizedKey, viewerId))) return null;

    // An empty return means "the base vanished mid-request" — 404, the same
    // answer the base itself would have given.
    const serveKey = variant ? await ensureMediaVariant(storage, variant) : key;
    if (!serveKey) return null;

    // The directive is set only when the policy grants it, so the returned
    // shape has no `cacheControl` key at all when it declines — the caller
    // answers its no-store default and nothing can mistake an undefined for
    // a decision.
    const url = await storage.signedGetUrl(serveKey, DEFAULT_SIGNED_URL_TTL);
    const cacheControl = redirectCachePolicy?.(key);
    return cacheControl ? { url, cacheControl } : { url };
  };
}
