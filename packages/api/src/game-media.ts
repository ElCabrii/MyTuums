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
 * New keys include the catalog version: games/<igdbId>-<imageId>.<version>.<ext>.
 * An unchanged cover is retained without upload; a changed cover gets a fresh
 * immutable path even if IGDB returns to an older image. Delayed cleanup from
 * an earlier run can therefore never delete a later run's upload.
 */
import { parseMediaVariantKey } from "./constants.js";
import { secondsUntilWindowEnd } from "./storage.js";

/** Retry-stable within one catalog version, never reused by another version. */
export function gameCoverObjectKey(
  igdbId: number,
  imageId: string,
  ext: string,
  version: string,
): string {
  return `games/${igdbId}-${imageId}.${version.replaceAll("-", "")}.${ext}`;
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
 * are public content under immutable keys, so a shared cache may hold
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
