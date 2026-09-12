/**
 * The storage half of link preview cards (issue #260): the `link_card` cache
 * row, the lead image's object lifecycle, and the read path the
 * `post.linkCard` procedure serves.
 *
 * The wire rules — the SSRF guard, the size/time caps, the Open Graph parser —
 * live in `./link-card-http.ts`; this module decides *when* to use them. The
 * answer is "at most once per URL per revalidation window": a fresh row (card
 * or negative) is served from the database, a stale one is refetched and
 * re-upserted, and every failure mode leaves the caller with either the stale
 * card or no card — never an error the post inherits.
 *
 * A post's stored content is never modified: the card is keyed by URL alone
 * and looked up by whichever post carries that URL.
 */
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { Context } from "./context.js";
import { linkCard, mediaIntent } from "@my-tuums/db/schema";
import {
  LINK_CARD_HTML_MAX_BYTES,
  LINK_CARD_IMAGE_MAX_BYTES,
  LINK_CARD_REFRESH_MS,
  LINK_CARD_SITE_NAME_MAX_LENGTH,
  type AllowedImageType,
} from "./constants.js";
import {
  guardedLinkFetch,
  parseOpenGraphMetadata,
  truncateCardField,
  type LinkFetchTransport,
} from "./link-card-http.js";
import { mediaPathFor } from "./image.js";
import { acceptPostImage, sniffImageType } from "./post-image.js";
import { beginMediaUpload, cleanupMediaIntents, mediaUploadIsLive } from "./media-intents.js";

/** The card as the API returns it. `imageUrl` is a `/media/` path, never the target's own URL. */
export interface LinkCardView {
  url: string;
  domain: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
}

const IMAGE_EXTENSION = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} satisfies Record<AllowedImageType, string>;

/** A fresh, unguessable key under which one card's lead image is stored. */
export function linkCardImageObjectKey(id: string, type: AllowedImageType): string {
  return `link-cards/${id}.${IMAGE_EXTENSION[type]}`;
}

/**
 * `/media/link-cards/*` authorization: any viewer, signed in or not.
 *
 * The image is public web content this app mirrored into its private bucket
 * precisely so it is never hot-linked from the target; there is no per-viewer
 * decision to make. Anonymous callers reach it through the public post
 * permalink (0.4.0), which renders the same cards a signed-in feed does.
 */
export function canViewLinkCardMedia(): Promise<boolean> {
  return Promise.resolve(true);
}

/** The content types whose bytes are worth parsing as a card target. */
function isHtmlContentType(contentType: string): boolean {
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}

/**
 * Normalizes a card target: absolute, http(s), fragment dropped. Returns
 * `null` for anything else — the caller treats that as "no card", mirroring
 * the client's own scheme rule (`linked-text.tsx` never links anything else).
 */
export function normalizeCardUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // The fragment never changes what the server returns, and two authors
  // pasting the same page with different anchors describe the same card.
  parsed.hash = "";
  return parsed.toString();
}

/**
 * Fetches a card's lead image and validates it from its bytes, or `null` when
 * there is nothing safe to store: no bucket, a refused or dead image target,
 * or bytes that are not a bounded raster image. The image goes through the
 * same guarded fetch and the same sniffing as an upload — a target that
 * answers `image/*` with HTML, or an SVG, stores nothing. The bytes are never
 * hot-linked from the target; they are stored under our own `/media/` key.
 */
async function fetchCardImage(
  imageUrl: string,
  transport: LinkFetchTransport,
  storage: Context["storage"],
  timeoutMs: number | undefined,
): Promise<{ key: string; bytes: Uint8Array; type: AllowedImageType } | null> {
  if (!storage) return null;

  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return null;
  }

  const result = await guardedLinkFetch(url, {
    transport,
    timeoutMs,
    maxBytes: LINK_CARD_IMAGE_MAX_BYTES,
    acceptContentType: (contentType) => contentType.startsWith("image/"),
  });
  if (!result.ok) return null;

  // Sniff, never trust the header: the declared type only decided whether the
  // bytes were worth reading. What is stored is what the magic bytes say —
  // and the upload rules' dimension and decode-bomb bounds apply to fetched
  // bytes exactly as they do to an uploaded file.
  const sniffed = sniffImageType(result.bytes);
  if (!sniffed) return null;
  const verdict = acceptPostImage(result.bytes, sniffed);
  if (!verdict.ok || !verdict.type) return null;

  return {
    key: linkCardImageObjectKey(crypto.randomUUID(), verdict.type),
    bytes: result.bytes,
    type: verdict.type,
  };
}

/**
 * Resolves the card for one URL through the cache.
 *
 * `options.timeoutMs` exists for tests; production always uses the default
 * deadline from `constants.ts`.
 */
export async function resolveLinkCard(
  context: Context,
  rawUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<LinkCardView | null> {
  const url = normalizeCardUrl(rawUrl);
  if (url === null) return null;

  const [cached] = await context.db.select().from(linkCard).where(eq(linkCard.url, url)).limit(1);
  // A purged URL never unfurls again — the row is a moderation decision, and
  // no revalidation window re-opens it (see `purgeLinkCard`).
  if (cached?.purgedAt) return null;
  if (cached && Date.now() - cached.fetchedAt.getTime() < LINK_CARD_REFRESH_MS) {
    return cardView(cached);
  }

  const fetched = await fetchCardMetadata(url, context.linkTransport, options.timeoutMs);
  const metadata = fetched?.metadata ?? null;

  // A revalidation that failed with a card already stored: keep serving the
  // stored card, and reset only its age. Overwriting the row with a negative
  // entry here would blank every post carrying the URL because one
  // revalidation window happened to catch the target down; the stored card is
  // the better answer until a fetch actually succeeds.
  if (!metadata && cached?.title && cached.domain) {
    const [current] = await context.db
      .update(linkCard)
      .set({ fetchedAt: sql`cast(unixepoch('subsec') * 1000 as integer)` })
      .where(and(eq(linkCard.url, url), isNull(linkCard.purgedAt)))
      .returning();
    return current ? cardView(current) : null;
  }

  // Store (or re-store) the snapshot. A negative entry — no title — caches the
  // refusal itself, so a post whose URL unfurls to nothing is not refetched on
  // every view of every post carrying it.
  const image = metadata?.imageUrl
    ? await fetchCardImage(
        metadata.imageUrl,
        context.linkTransport,
        context.storage,
        options.timeoutMs,
      )
    : null;
  let imageMediaPath: string | null = null;

  const card = fetched?.metadata
    ? {
        domain:
          fetched.metadata.siteName ??
          truncateCardField(fetched.finalUrl.hostname, LINK_CARD_SITE_NAME_MAX_LENGTH),
        title: fetched.metadata.title,
        description: fetched.metadata.description,
      }
    : { domain: null, title: null, description: null };

  const storage = context.storage;
  const scope = `link:${url}`;
  let uploadId: string | null = null;
  if (image && storage) {
    const path = mediaPathFor(image.key);
    uploadId = await beginMediaUpload(context.db, scope, [path]);
    try {
      await storage.put(image.key, image.bytes, image.type);
      imageMediaPath = path;
    } catch {
      // Keep the intent for recovery even if PUT committed before its error.
      // The card stays text-only rather than pointing at a missing image.
    }
  }
  const [, , current] = await context.db.batch([
    context.db
      .insert(linkCard)
      .select(
        sql`select ${crypto.randomUUID()}, ${url},
      ${card.domain}, ${card.title}, ${card.description}, ${imageMediaPath},
      cast(unixepoch('subsec') * 1000 as integer), null, null, null
      where ${imageMediaPath && uploadId ? mediaUploadIsLive(uploadId) : sql`true`}`,
      )
      .onConflictDoUpdate({
        target: linkCard.url,
        set: {
          ...card,
          imageMediaPath,
          fetchedAt: sql`cast(unixepoch('subsec') * 1000 as integer)`,
        },
        setWhere: isNull(linkCard.purgedAt),
      }),
    context.db.delete(mediaIntent).where(
      and(
        eq(mediaIntent.id, uploadId ?? ""),
        sql`exists (select 1 from ${linkCard} where ${linkCard.url} = ${url}
        and ${linkCard.imageMediaPath} = ${imageMediaPath} and ${linkCard.purgedAt} is null)`,
      ),
    ),
    context.db.select().from(linkCard).where(eq(linkCard.url, url)),
  ]);
  if (storage)
    await cleanupMediaIntents(context.db, storage, scope).catch(() => {
      console.error({ event: "link_card_cleanup_deferred" });
    });
  // Return the committed row, including a purge that won during the fetch.
  return current[0] ? cardView(current[0]) : null;
}

type CachedCard = typeof linkCard.$inferSelect;

/** The view of a stored row: a title is what makes a row a card. */
function cardView(row: CachedCard): LinkCardView | null {
  if (row.purgedAt || !row.title || !row.domain) return null;
  return {
    url: row.url,
    domain: row.domain,
    title: row.title,
    description: row.description,
    imageUrl: row.imageMediaPath,
  };
}

/** One attempt at the HTML fetch + parse. `null` metadata = no card this time. */
async function fetchCardMetadata(
  url: string,
  transport: LinkFetchTransport,
  timeoutMs: number | undefined,
): Promise<{ metadata: ReturnType<typeof parseOpenGraphMetadata>; finalUrl: URL } | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }

  const result = await guardedLinkFetch(target, {
    transport,
    timeoutMs,
    maxBytes: LINK_CARD_HTML_MAX_BYTES,
    acceptContentType: isHtmlContentType,
  });
  if (!result.ok) return null;

  const html = new TextDecoder().decode(result.bytes);
  return { metadata: parseOpenGraphMetadata(html, result.finalUrl), finalUrl: result.finalUrl };
}

/** Purge and attribution commit with durable image cleanup; a purged URL never unfurls again. */
export async function purgeLinkCard(
  context: Context,
  input: { url: string; actorId: string; reason: string },
): Promise<void> {
  const url = normalizeCardUrl(input.url);
  if (url === null) {
    throw new ORPCError("BAD_REQUEST", { message: "This URL can't have a preview card." });
  }

  const [before] = await context.db.batch([
    context.db.select().from(linkCard).where(eq(linkCard.url, url)),
    context.db
      .update(linkCard)
      .set({
        domain: null,
        title: null,
        description: null,
        imageMediaPath: null,
        purgedAt: sql`cast(unixepoch('subsec') * 1000 as integer)`,
        purgedBy: input.actorId,
        purgedReason: input.reason,
      })
      .where(and(eq(linkCard.url, url), isNotNull(linkCard.title), isNull(linkCard.purgedAt))),
  ]);
  const row = before[0];
  if (!row || row.title === null) {
    throw new ORPCError("NOT_FOUND", { message: "This URL has no preview card." });
  }
  if (row.purgedAt) {
    throw new ORPCError("BAD_REQUEST", { message: "This URL's preview card is already purged." });
  }
  if (context.storage)
    await cleanupMediaIntents(context.db, context.storage, `link:${url}`).catch(() => {
      console.error({ event: "link_card_cleanup_deferred" });
    });
}
