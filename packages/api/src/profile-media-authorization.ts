/**
 * Authorizes a `/media/` request for a profile image — an avatar or banner,
 * display or original. Post attachments have their own authorizer
 * (./post-media.ts); this is the profile half of the resolver dispatch in
 * `apps/server/src/index.ts`.
 *
 * ## Why profile media needs a viewer at all
 *
 * The media route used to treat profile keys as public-once-authenticated:
 * any signed-in caller could fetch any avatar or banner by knowing its key.
 * The keys are unguessable (uuid per object), but they leak — a pasted link,
 * browser history, a log line — and while a display object is meant to be
 * public-ish, the `.orig` pair is the owner's untouched file, kept for a
 * future editor, and was served to any authenticated caller under exactly the
 * same rule. That is the privacy hole this module closes: every profile key,
 * like every post key, is now resolved through a per-viewer authorization
 * decision.
 *
 * Two rules, one row read:
 *
 * - A **display** object is what feeds and profiles render, so any viewer who
 *   can see the owner may fetch it. Visibility is the same predicate every
 *   other surface applies (`visibleUser`): a ban hides, a block in either
 *   direction hides. The owner may always fetch their own.
 * - An **original** is the owner's private file. Only the owner may fetch it,
 *   and only while the row still points at it — a replaced or removed image's
 *   stale key reads as a 404 rather than a redirect to a superseded object.
 *
 * The request must name the object the row currently references: the row's
 * stored path is compared against the requested key, so a stale or forged key
 * that happens to parse is still a 404. That comparison is also what makes
 * this safe against the object keys of OTHER users: the key's owner segment
 * decides whose row is read, and only that row's current columns can match.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { user } from "@my-tuums/db/schema";
import { parseMediaVariantKey } from "./constants.js";
import { mediaPathFor } from "./image.js";
import { secondsUntilWindowEnd } from "./storage.js";
import { visibleUser } from "./visibility.js";

/**
 * The key shape of one profile-image object, parsed so the authorizer can tell
 * which slot and variant is being asked for. `isSafeObjectKey` has already
 * vetted the key at the route; this parse names the column to compare.
 */
const PROFILE_KEY_RE =
  /^(avatars|banners)\/([A-Za-z0-9_-]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(\.orig)?\.(webp|png|jpg|gif)$/;

/**
 * The Cache-Control a `/media/` redirect may carry for this key, or `null`
 * when its redirect must never be stored.
 *
 * A **display** object is what feeds and profiles render for every viewer who
 * can already see the owner, so its redirect is the one place caching is both
 * safe and worth it: `private` (never a shared cache), and bounded by the
 * signing window (`secondsUntilWindowEnd`) so a stored redirect cannot
 * outlive the signature it points at. The per-view authorization still runs
 * on every cache miss — a block, ban or profile swap takes effect at most one
 * window later on a browser that had the image warm, which is the accepted
 * posture display objects always had before the blanket no-store.
 *
 * An **original** is the owner's private file: its redirect is never stored,
 * so a shared browser cannot hand it to whoever sits down next. Anything that
 * does not parse as profile media (post attachments included) gets `null`
 * too — post-media redirects have always been viewer-authorized decisions
 * that must not be reused.
 */
export function profileDisplayRedirectCacheControl(key: string): string | null {
  // A variant key (`…/uuid.webp.w96.webp`) is a display object's derived size —
  // the same rule applies to the base it derives from.
  const base = parseMediaVariantKey(key)?.baseKey ?? key;
  const match = PROFILE_KEY_RE.exec(base);
  if (!match || match[4]) return null;
  return `private, max-age=${secondsUntilWindowEnd()}`;
}

/**
 * Whether the viewer may fetch this profile-media key.
 *
 * `viewerId` may be `null` — the anonymous post-permalink reader (0.4.0),
 * whose page renders author avatars and therefore needs the display objects.
 * The two rules degrade naturally: a display object is visible to a viewer
 * who can see the owner, and an anonymous viewer's visibility is the same
 * predicate with no block edges (only an active ban hides the owner); an
 * original stays owner-only, and a null viewer is nobody's owner.
 */
export async function canViewProfileMedia(
  db: Database,
  key: string,
  viewerId: string | null,
): Promise<boolean> {
  const match = PROFILE_KEY_RE.exec(key);
  if (!match) return false;

  const [, kind, ownerId, , original] = match;
  const path = mediaPathFor(key);

  const [row] = await db
    .select({
      display: kind === "avatars" ? user.image : user.bannerImage,
      original: kind === "avatars" ? user.imageOriginal : user.bannerImageOriginal,
      visibleToViewer: visibleUser(viewerId),
    })
    .from(user)
    .where(and(eq(user.id, ownerId)))
    .limit(1);
  if (!row) return false;

  if (!original) {
    return row.display === path && (ownerId === viewerId || row.visibleToViewer);
  }
  return viewerId !== null && ownerId === viewerId && row.original === path;
}
