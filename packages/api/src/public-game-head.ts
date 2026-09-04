/**
 * The crawler-facing head of one public game page — `/games/{slug}`'s
 * server-side half, the twin of `public-post-head.ts` (issue #314).
 *
 * Same reasoning: the SPA emits the route's `<head>` only after mount, and
 * the public game directory is crawlable (issue Q6), so unfurlers need the
 * name/summary/cover from one small query before any JavaScript runs. The
 * catalog is public by construction — no visibility predicate exists to
 * apply — so `null` means only "no such slug", which serves the generic
 * fallback while the SPA itself shows its own not-found state.
 *
 * The excerpt rules mirror the web app's `gamePageName`/description (same
 * whitespace collapse, same ellipsis, same 68/160 bounds) so an unfurl never
 * disagrees with the tab title the SPA produces a moment later.
 */
import { eq } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { game } from "@my-tuums/db/schema";
import { mediaVariantPath } from "./constants.js";

/** Mirrors `POST_TITLE_MAX_LENGTH` in apps/web's document-head.ts. */
const TITLE_MAX_LENGTH = 68;
/** Mirrors `META_DESCRIPTION_MAX_LENGTH` there. */
const DESCRIPTION_MAX_LENGTH = 160;

export interface PublicGameHead {
  /** The game's name — what the `<title>` and og:title are built from. */
  title: string;
  /** The meta/og:description text. */
  description: string;
  /** The cover's `/media/…` path at og-image width, or null when it has none. */
  imagePath: string | null;
}

/** The web app's `truncate`, restated: ellipsis on a word-ish boundary. */
function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}

/** The head of one game, or `null` when no such slug exists. */
export async function publicGameHead(db: Database, slug: string): Promise<PublicGameHead | null> {
  const [row] = await db
    .select({
      name: game.name,
      summary: game.summary,
      coverMediaPath: game.coverMediaPath,
    })
    .from(game)
    .where(eq(game.slug, slug))
    .limit(1);

  if (!row) return null;

  const collapsed = row.summary?.replace(/\s+/gu, " ").trim() ?? "";
  return {
    title: truncate(row.name, TITLE_MAX_LENGTH),
    description: collapsed
      ? truncate(collapsed, DESCRIPTION_MAX_LENGTH)
      : `${row.name} on MyTuums — the social media, for gamers.`,
    imagePath: row.coverMediaPath ? mediaVariantPath(row.coverMediaPath, 640) : null,
  };
}
