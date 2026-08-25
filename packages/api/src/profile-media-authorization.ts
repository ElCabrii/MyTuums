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
import { mediaPathFor } from "./image.js";
import { visibleUser } from "./visibility.js";

/**
 * The key shape of one profile-image object, parsed so the authorizer can tell
 * which slot and variant is being asked for. `isSafeObjectKey` has already
 * vetted the key at the route; this parse names the column to compare.
 */
const PROFILE_KEY_RE =
  /^(avatars|banners)\/([A-Za-z0-9_-]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(\.orig)?\.(webp|png|jpg)$/;

/** Whether the viewer may fetch this profile-media key. */
export async function canViewProfileMedia(
  db: Database,
  key: string,
  viewerId: string,
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
  return ownerId === viewerId && row.original === path;
}
