/**
 * The serving half of game covers (issue #314): key shape, authorization, and
 * the redirect cache policy — the games counterpart of
 * `./profile-media-authorization.ts`, minus everything that made profile
 * media need a module of rules.
 *
 * A cover is public catalog content this app mirrored, exactly like a stored
 * link preview's lead image (see `canViewLinkCardMedia`): no per-viewer
 * decision exists to make, so the authorizer is a constant and the whole
 * module is shape + policy.
 *
 * The key is `games/<igdbId>-<imageId>.<ext>`, where `imageId` is IGDB's own
 * image hash. That makes it content-addressed — a re-sync of an unchanged
 * cover re-uploads the same bytes under the same key — which is what licenses
 * the `public` redirect cache below: the object a key names never changes, so
 * no staleness budget exists to bound beyond the signature's own life.
 */
import { parseMediaVariantKey } from "./constants.js";
import { secondsUntilWindowEnd } from "./storage.js";

/**
 * The bucket key under which a game's cover is re-hosted. Deterministic in
 * (igdbId, imageId) so the sync's uploads are idempotent: a run that dies
 * mid-sync leaves objects the next successful run references rather than
 * orphans, and a repeat sync of an unchanged cover performs no upload at all.
 */
export function gameCoverObjectKey(igdbId: number, imageId: string, ext: string): string {
  return `games/${igdbId}-${imageId}.${ext}`;
}

/**
 * Whether the viewer may fetch a game-cover key. `true` for every viewer —
 * including the anonymous reader of the public `/games` pages — because the
 * catalog is public by design (issue Q6); the signature is in the JSDoc above.
 */
export function canViewGameCoverMedia(): Promise<boolean> {
  return Promise.resolve(true);
}

/**
 * The Cache-Control a game-cover redirect may carry, or `null` when it must
 * not be stored. Unlike every other media class, this one is `public`: covers
 * are public content under content-addressed keys, so a shared cache may hold
 * the redirect. The `max-age` is still bounded by the presigned URL's
 * remaining signing window (`secondsUntilWindowEnd`) so a stored redirect can
 * never outlive the signature it points at — the same budget
 * `profileDisplayRedirectCacheControl` applies, minus the private qualifier
 * its per-viewer decision requires.
 *
 * Anything that is not a `games/` key gets `null` — this policy is one arm of
 * the resolver dispatch in `apps/server/src/index.ts`, not a standalone one.
 */
export function gameCoverRedirectCacheControl(key: string): string | null {
  const base = parseMediaVariantKey(key)?.baseKey ?? key;
  if (!base.startsWith("games/")) return null;
  return `public, max-age=${secondsUntilWindowEnd()}`;
}
