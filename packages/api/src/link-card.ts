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
import { randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { Context } from "./context.js";
import { linkCard } from "@my-tuums/db/schema";
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
import { mediaPathFor, objectKeyFromMediaPath } from "./image.js";
import { acceptPostImage, sniffImageType } from "./post-image.js";
import { acquirePostMediaLifecycleLock } from "./post-media-lock.js";

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
 * `/media/link-cards/*` authorization: any signed-in viewer.
 *
 * The image is public web content this app mirrored into its private bucket
 * precisely so it is never hot-linked from the target; there is no per-viewer
 * decision to make. The session requirement itself is not made here — the
 * `/media` route demands one before the key is even parsed (see
 * `apps/server/src/request-handler.ts`), the same arrangement the post and
 * profile authorizers run under.
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
    key: linkCardImageObjectKey(randomUUID(), verdict.type),
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
    await context.db.update(linkCard).set({ fetchedAt: new Date() }).where(eq(linkCard.url, url));
    return {
      url: cached.url,
      domain: cached.domain,
      title: cached.title,
      description: cached.description,
      imageUrl: cached.imageMediaPath,
    };
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
  const imageMediaPath = image ? mediaPathFor(image.key) : null;

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
  await context.db.transaction(async (tx) => {
    // The same lifecycle lock post attachments take: the reconciler's
    // list-then-read pass cannot land between this object write and the row
    // that references it, so a card image cannot be reaped as an orphan while
    // its row is being born.
    await acquirePostMediaLifecycleLock(tx);
    if (image && storage) {
      try {
        await storage.put(image.key, image.bytes, image.type);
      } catch {
        // A bucket failure downgrades the card to text-only; the row still
        // records the fetch so the window is not retried on every view.
      }
    }
    await tx
      .insert(linkCard)
      .values({
        url,
        domain: card.domain,
        title: card.title,
        description: card.description,
        imageMediaPath,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: linkCard.url,
        set: {
          domain: card.domain,
          title: card.title,
          description: card.description,
          imageMediaPath,
          fetchedAt: new Date(),
        },
        // A purge may have committed between this call's cache read and the
        // upsert: without this condition a revalidation in flight when the
        // purge landed would write its card fields back onto the purged row.
        // Losing that race leaves the fetched snapshot unconsumed; the row
        // keeps its purge, which is the newer decision.
        setWhere: isNull(linkCard.purgedAt),
      });
  });

  // The object the previous row pointed at, if any, is now unreferenced —
  // whether the new snapshot replaced it with another image or dropped the
  // image entirely. Best effort: a missed removal is an orphan the reconcile
  // pass reaps, and a failed one must never fail the card.
  const previousPath = cached?.imageMediaPath ?? null;
  const previousKey = previousPath !== imageMediaPath ? objectKeyFromMediaPath(previousPath) : null;
  if (storage && previousKey) {
    await storage.remove(previousKey).catch(() => {});
  }

  if (metadata) {
    return {
      url,
      domain: card.domain!,
      title: card.title!,
      description: card.description,
      imageUrl: imageMediaPath,
    };
  }
  return null;
}

type CachedCard = typeof linkCard.$inferSelect;

/** The view of a stored row: a title is what makes a row a card. */
function cardView(row: CachedCard): LinkCardView | null {
  if (!row.title || !row.domain) return null;
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

/**
 * Purges a URL's preview card — the staff lever for a hostile unfurl
 * (`moderation.purgeLinkCard`).
 *
 * A card is shared by every post carrying the URL, so this is the one action
 * that makes all of them lose the preview at once. The row is not deleted: a
 * deletion would be refetched on the very next view and the card would come
 * back. It is stamped `purgedAt` with the actor and reason, its card fields
 * are nulled, and `resolveLinkCard` refuses a purged URL outright — no
 * revalidation window ever re-opens it.
 *
 * The attribution lives on the row rather than in `moderation_action`, whose
 * target columns are post- and user-shaped by schema; the purge keeps the
 * audit trail the moderation effects keep (who, why, when, `FOR UPDATE` on
 * the guarded row inside one transaction) against the thing it acts on.
 *
 * The superseded image object is removed best-effort AFTER the commit, the
 * same ordering as the profile-media lifecycle: a failed removal is an orphan
 * the reconcile pass reaps, never a purge that half-happened.
 */
export async function purgeLinkCard(
  context: Context,
  input: { url: string; actorId: string; reason: string },
): Promise<void> {
  const url = normalizeCardUrl(input.url);
  if (url === null) {
    throw new ORPCError("BAD_REQUEST", { message: "This URL can't have a preview card." });
  }

  let previousPath: string | null = null;
  await context.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        title: linkCard.title,
        purgedAt: linkCard.purgedAt,
        imageMediaPath: linkCard.imageMediaPath,
      })
      .from(linkCard)
      .where(eq(linkCard.url, url))
      .for("update")
      .limit(1);
    if (!row || row.title === null) {
      throw new ORPCError("NOT_FOUND", { message: "This URL has no preview card." });
    }
    // Refused rather than a no-op so a repeat purge cannot overwrite the
    // first purge's attribution — the same reasoning that makes
    // `removePost` refuse an already-removed post.
    if (row.purgedAt) {
      throw new ORPCError("BAD_REQUEST", { message: "This URL's preview card is already purged." });
    }
    previousPath = row.imageMediaPath;
    await tx
      .update(linkCard)
      .set({
        domain: null,
        title: null,
        description: null,
        imageMediaPath: null,
        purgedAt: new Date(),
        purgedBy: input.actorId,
        purgedReason: input.reason,
      })
      .where(eq(linkCard.url, url));
  });

  const previousKey = objectKeyFromMediaPath(previousPath);
  if (context.storage && previousKey) {
    await context.storage.remove(previousKey).catch(() => {});
  }
}
