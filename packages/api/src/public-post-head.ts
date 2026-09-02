/**
 * The crawler-facing head of one public post permalink — the server-side half
 * of unfurls (0.4.0).
 *
 * The SPA renders per-route `<head>` tags only after it mounts
 * (`apps/web/src/lib/document-head.ts`), which a crawler or unfurler that
 * never runs JavaScript never sees; until now that was fine because every
 * route redirected a signed-out fetcher to `/login`. Post permalinks are
 * public now, so `apps/server` needs the title/description/canonical/og:image
 * a post page deserves BEFORE any JS runs, and it needs it from one small
 * query rather than the whole `postSelection`.
 *
 * The excerpt rules mirror `postPageName`/`postPageDescription` in the web
 * app (same whitespace collapse, same ellipsis style, same 68/160 bounds) so
 * an unfurl never disagrees with the tab title the SPA produces a moment
 * later. The visibility rule is the anonymous reader's, on purpose: the same
 * predicate `post.thread` applies (no tombstones, no hidden authors), so a
 * page the public API would 404 never leaks a head.
 */
import { and, eq, isNull, not, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { post, postAttachment, user } from "@my-tuums/db/schema";
import { mediaVariantPath } from "./constants.js";
import { invisibleAuthor } from "./visibility.js";

/** Mirrors `POST_TITLE_MAX_LENGTH` in apps/web's document-head.ts. */
const TITLE_MAX_LENGTH = 68;
/** Mirrors `META_DESCRIPTION_MAX_LENGTH` in apps/web's document-head.ts. */
const DESCRIPTION_MAX_LENGTH = 160;

export interface PublicPostHead {
  /** The post's excerpt — what the `<title>` and og:title are built from. */
  title: string;
  /** The meta/og:description text. */
  description: string;
  /** The first attachment's `/media/…` path at og-image width, or null. */
  imagePath: string | null;
}

/** The web app's `truncate`, restated: ellipsis on a word-ish boundary. */
function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}

/**
 * The head of one post, or `null` when the permalink must not be described
 * publicly (missing, removed, deleted, or hidden author).
 */
export async function publicPostHead(db: Database, postId: string): Promise<PublicPostHead | null> {
  const uuidFilter = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(postId);

  const [row] = await db
    .select({
      content: post.content,
      imagePath: sql<string | null>`(
        select ${postAttachment.mediaPath}
        from ${postAttachment}
        where ${postAttachment.postId} = ${post.id}
        order by ${postAttachment.position}
        limit 1
      )`,
    })
    .from(post)
    .innerJoin(user, eq(user.id, post.authorId))
    .where(
      and(
        uuidFilter ? eq(post.id, postId) : sql`false`,
        isNull(post.removedAt),
        isNull(post.deletedAt),
        not(invisibleAuthor(null)),
      ),
    )
    .limit(1);

  if (!row) return null;

  const collapsed = row.content?.replace(/\s+/gu, " ").trim();
  return {
    title: collapsed ? truncate(collapsed, TITLE_MAX_LENGTH) : "Post",
    description: collapsed
      ? truncate(collapsed, DESCRIPTION_MAX_LENGTH)
      : "The social media, for gamers.",
    imagePath: row.imagePath ? mediaVariantPath(row.imagePath, 1280) : null,
  };
}
