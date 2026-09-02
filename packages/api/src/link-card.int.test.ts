/**
 * Integration pins for link preview cards (issue #260).
 *
 * The headline risk is SSRF: a signed-in author's text must never be able to
 * make the server dial a private address. The private-range pins below run
 * against a REAL local HTTP server and the REAL production transport — a
 * loopback listener that would answer if anything reached it — so they prove
 * the refusal, not a mock of it. The behavioural pins (fetch once per window,
 * the stored lead image, negative caching) use a fake transport for the same
 * reason the post-attachment suite uses a fake bucket: the boundary under test
 * is the procedure and the row, not somebody else's web server.
 */
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import { call } from "@orpc/server";
import { closeDb, db } from "@my-tuums/db";
import { linkCard } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "./context.js";
import { appRouter } from "./router.js";
import { createRateLimiter } from "./rate-limit.js";
import { resolveLinkCard } from "./link-card.js";
import { createLinkFetchTransport, type LinkFetchTransport } from "./link-card-http.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  freshSessionFor,
  setUserRole,
  testStorageObjects,
  truncateAll,
  type TestUser,
} from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/** A genuine 2x2 PNG — the stored lead image validates real container bytes. */
const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4y8AARAwQCgAfrgP19hgqWQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const OG_PAGE = `
  <html><head>
    <meta property="og:site_name" content="Example Weekly">
    <meta property="og:title" content="A very good article">
    <meta property="og:description" content="What it is about">
    <meta property="og:image" content="/cover.png">
  </head></html>`;

/**
 * A transport that answers the two requests a happy-path card makes from
 * memory, counting both. Lookups resolve globally so the address guard runs
 * and passes for real.
 */
function scriptedTransport(options: {
  html?: () => string;
  image?: () => Uint8Array;
}): LinkFetchTransport & { htmlRequests: number; imageRequests: number } {
  const transport: LinkFetchTransport & { htmlRequests: number; imageRequests: number } = {
    htmlRequests: 0,
    imageRequests: 0,
    lookup: () => Promise.resolve(["93.184.216.34"]),
    fetch: (target) => {
      if (target.pathname === "/cover.png") {
        transport.imageRequests += 1;
        const image = options.image?.();
        if (image === undefined) return Promise.reject(new Error("connection reset"));
        return Promise.resolve(new Response(image, { headers: { "content-type": "image/png" } }));
      }
      transport.htmlRequests += 1;
      const html = options.html?.();
      if (html === undefined) return Promise.reject(new Error("connection reset"));
      return Promise.resolve(
        new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
      );
    },
  };
  return transport;
}

/** A context whose link traffic goes to `transport`. */
function contextWithTransport(user: TestUser, transport: LinkFetchTransport): Context {
  return { ...contextFor(user), linkTransport: transport };
}

/** Every test fetches a URL of its own — `link_card` rows survive across tests in this file.
 */
const url = (path: string) => `https://example.com${path}`;

describe("post.linkCard", () => {
  it("refuses to fetch a loopback target — a real local server that never hears a request", async () => {
    const user = await createTestUser();
    let requests = 0;
    const server: Server = await new Promise((resolve) => {
      const listener = createServer((req, res) => {
        requests += 1;
        res.writeHead(200, { "content-type": "text/html" });
        res.end(OG_PAGE);
      });
      listener.listen(0, "127.0.0.1", () => resolve(listener));
    });
    // SAFETY: the listener is bound and listening by the time the listen
    // callback runs, so `address()` is the non-null AddressInfo form.
    const port = (server.address() as { port: number }).port;

    try {
      // A literal loopback IP (dotted and bracketed IPv6), and the
      // `localhost` name that resolves to it — all must be refused before any
      // connection is attempted.
      for (const target of [
        `http://127.0.0.1:${port}/page`,
        `http://localhost:${port}/page`,
        `http://[::1]:${port}/page`,
      ]) {
        const result = await call(
          appRouter.post.linkCard,
          { url: target },
          { context: contextFor(user) },
        );
        expect(result.card).toBeNull();
      }
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a private-range target by literal address", async () => {
    const user = await createTestUser();
    const result = await call(
      appRouter.post.linkCard,
      { url: "http://192.168.1.10/admin" },
      { context: contextFor(user) },
    );
    expect(result.card).toBeNull();

    // And the refusal is cached: no row, or a negative one — never a card.
    const [row] = await db
      .select()
      .from(linkCard)
      .where(eq(linkCard.url, "http://192.168.1.10/admin"));
    expect(row?.title ?? null).toBeNull();
  });

  it("the transport's own fetch refuses a loopback connect — the rebinding backstop holds without the pre-flight", async () => {
    // The pins above prove `guardedLinkFetch` refuses before fetching; this
    // one proves the SECOND layer: the default transport's fetch rides a
    // dispatcher whose connect-time lookup re-applies the range table, so
    // even a resolver answer the pre-flight never saw cannot open a socket
    // to loopback. A rebinding DNS server exploits exactly that gap — a
    // public answer for the check, a private one for the connect — and this
    // is the closest a test without a hostile resolver can get to it: call
    // fetch directly, with no pre-flight, against a name that re-resolves
    // to 127.0.0.1.
    let requests = 0;
    const server: Server = await new Promise((resolve) => {
      const listener = createServer((req, res) => {
        requests += 1;
        res.writeHead(200, { "content-type": "text/html" });
        res.end(OG_PAGE);
      });
      listener.listen(0, "127.0.0.1", () => resolve(listener));
    });
    // SAFETY: the listener is bound and listening by the time the listen
    // callback runs, so `address()` is the non-null AddressInfo form.
    const port = (server.address() as { port: number }).port;

    try {
      const transport = createLinkFetchTransport();
      const settled = await transport
        .fetch(new URL(`http://localhost:${port}/page`), {
          signal: new AbortController().signal,
        })
        .then(
          () => undefined,
          (error: Error) => error,
        );
      expect(settled).toBeInstanceOf(Error);
      const cause = settled instanceof Error ? settled.cause : undefined;
      expect(cause).toBeInstanceOf(Error);
      expect(cause instanceof Error ? cause.message : "").toContain("connect-time");
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a non-http(s) URL at the input schema", async () => {
    const user = await createTestUser();
    await expect(
      call(appRouter.post.linkCard, { url: "javascript:alert(1)" }, { context: contextFor(user) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("serves an unauthenticated caller the card a public permalink renders (0.4.0)", async () => {
    // linkCard became session-optional with the public post permalink: an
    // anonymous reader resolves the same cached card a feed does, and the
    // outbound fetch behind a miss stays bounded by the transport scripted
    // below (in production: the SSRF guard, size/time caps and the IP-keyed
    // rate limit) — and can only be spent on a URL off a readable post.
    const transport = scriptedTransport({ html: () => OG_PAGE, image: () => PNG_BYTES });
    const result = await call(
      appRouter.post.linkCard,
      { url: url("/auth") },
      { context: { ...anonContext, linkTransport: transport } },
    );

    expect(result.card).not.toBeNull();
    // The negative-cache and single-fetch-per-window rules apply to the
    // anonymous caller exactly as to a signed-in one.
    await call(
      appRouter.post.linkCard,
      { url: url("/auth") },
      { context: { ...anonContext, linkTransport: transport } },
    );
    expect(transport.htmlRequests).toBe(1);
    expect(transport.imageRequests).toBe(1);
  });

  it("returns the card, stores the lead image under /media/, and fetches the URL only once per window", async () => {
    const user = await createTestUser();
    const transport = scriptedTransport({ html: () => OG_PAGE, image: () => PNG_BYTES });

    const pageUrl = url("/once");
    const first = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, transport) },
    );
    expect(first.card).toEqual({
      url: pageUrl,
      domain: "Example Weekly",
      title: "A very good article",
      description: "What it is about",
      imageUrl: first.card?.imageUrl ?? null,
    });

    // The image is stored under our own prefix and served from /media/, never
    // hot-linked from the target.
    expect(first.card?.imageUrl).toMatch(/^\/media\/link-cards\/[a-f0-9-]+\.png$/);

    const second = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, transport) },
    );
    expect(second.card).toEqual(first.card);
    expect(transport.htmlRequests).toBe(1);
    expect(transport.imageRequests).toBe(1);
  });

  it("refetches once the revalidation window has expired, replacing the stored image", async () => {
    const user = await createTestUser();
    const transport = scriptedTransport({ html: () => OG_PAGE, image: () => PNG_BYTES });

    const pageUrl = url("/revalidate");
    const first = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, transport) },
    );
    const firstImage = first.card?.imageUrl;

    // Age the row past the window, then ask again: one more fetch pair, a new
    // image object, and the previous object removed.
    await db
      .update(linkCard)
      .set({ fetchedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(linkCard.url, pageUrl));

    const second = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, transport) },
    );
    expect(transport.htmlRequests).toBe(2);
    expect(second.card?.imageUrl).toMatch(/^\/media\/link-cards\//);
    expect(second.card?.imageUrl).not.toBe(firstImage);
    const [row] = await db.select().from(linkCard).where(eq(linkCard.url, pageUrl));
    expect(row?.imageMediaPath).toBe(second.card?.imageUrl);
  });

  it("caches a URL with no Open Graph payload as a negative entry — once per window, not per view", async () => {
    const user = await createTestUser();
    const transport = scriptedTransport({
      html: () => "<html><head><title>not open graph</title></head></html>",
    });

    const pageUrl = url("/no-payload");
    const first = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, transport) },
    );
    expect(first.card).toBeNull();

    const second = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, transport) },
    );
    expect(second.card).toBeNull();
    expect(transport.htmlRequests).toBe(1);

    const [row] = await db.select().from(linkCard).where(eq(linkCard.url, pageUrl));
    expect(row?.title).toBeNull();
  });

  it("keeps serving the stale card when a revalidation fetch fails — the row keeps its card too", async () => {
    const user = await createTestUser();
    const pageUrl = url("/stale-grace");
    const seeded = scriptedTransport({ html: () => OG_PAGE, image: () => PNG_BYTES });
    const first = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, seeded) },
    );
    expect(first.card).not.toBeNull();

    await db
      .update(linkCard)
      .set({ fetchedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(linkCard.url, pageUrl));

    const dead = scriptedTransport({ html: undefined });
    const second = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, dead) },
    );
    expect(second.card).toEqual(first.card);

    // The failed revalidation must not blank the row: a negative overwrite
    // here would make the very next request (fresh row) drop every post
    // carrying the URL back to a plain link because one window caught the
    // target down.
    const [row] = await db.select().from(linkCard).where(eq(linkCard.url, pageUrl));
    expect(row?.title).toBe(first.card?.title);
    expect(row?.imageMediaPath).toBe(first.card?.imageUrl);

    // And the next caller is served from that preserved row without another
    // doomed outbound attempt.
    const third = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, dead) },
    );
    expect(third.card).toEqual(first.card);
    expect(dead.htmlRequests).toBe(1);
  });

  it("refuses an oversized target and a slow one, and the post still gets no card", async () => {
    const user = await createTestUser();
    const oversized: LinkFetchTransport = {
      lookup: () => Promise.resolve(["93.184.216.34"]),
      fetch: () =>
        Promise.resolve(
          new Response("x".repeat(1024 * 1024), { headers: { "content-type": "text/html" } }),
        ),
    };
    expect(
      await resolveLinkCard(contextWithTransport(user, oversized), url("/oversized"), {
        timeoutMs: 1000,
      }),
    ).toBeNull();

    const slow: LinkFetchTransport = {
      lookup: () => Promise.resolve(["93.184.216.34"]),
      fetch: () => new Promise<Response>(() => {}),
    };
    expect(
      await resolveLinkCard(contextWithTransport(user, slow), url("/slow"), { timeoutMs: 50 }),
    ).toBeNull();
  });

  it("a refresh whose new snapshot has no image removes the previous object too", async () => {
    const user = await createTestUser();
    const pageUrl = url("/image-dropped");
    // First fetch: a card with a lead image.
    const withImage = scriptedTransport({ html: () => OG_PAGE, image: () => PNG_BYTES });
    const first = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, withImage) },
    );
    expect(first.card?.imageUrl).toMatch(/^\/media\/link-cards\//);
    const firstKey = first.card?.imageUrl?.replace("/media/", "");
    expect(firstKey && testStorageObjects.has(firstKey)).toBe(true);

    // Age the row, then refetch a page that no longer offers an image: the
    // old object must not linger in the bucket until reconcile-media runs.
    await db
      .update(linkCard)
      .set({ fetchedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(linkCard.url, pageUrl));

    const bare = `<html><head>
        <meta property="og:site_name" content="Example Weekly">
        <meta property="og:title" content="A very good article">
      </head></html>`;
    const withoutImage = scriptedTransport({ html: () => bare });
    const second = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(user, withoutImage) },
    );
    expect(second.card?.imageUrl).toBeNull();
    expect(firstKey && testStorageObjects.has(firstKey)).toBe(false);
  });

  it("the linkCard tier gates the procedure — a 301st unfurl in a minute trips TOO_MANY_REQUESTS", async () => {
    const user = await createTestUser();
    const transport = scriptedTransport({ html: () => OG_PAGE, image: () => PNG_BYTES });
    const isolated = createRateLimiter();
    const context: Context = { ...contextFor(user, isolated), linkTransport: transport };

    const pageUrl = url("/budget");
    for (let i = 0; i < 300; i += 1) {
      await call(appRouter.post.linkCard, { url: pageUrl }, { context });
    }

    await expect(
      call(appRouter.post.linkCard, { url: pageUrl }, { context }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("moderation.purgeLinkCard", () => {
  /** A user promoted to moderator through the row, re-fetched so the session carries the role. */
  async function moderatorUser(): Promise<TestUser> {
    const user = await createTestUser();
    await setUserRole(user.id, "moderator");
    return freshSessionFor(user);
  }

  it("purges the card for every post carrying the URL — permanently, and removes the stored image", async () => {
    const viewer = await createTestUser();
    const moderator = await moderatorUser();
    const transport = scriptedTransport({ html: () => OG_PAGE, image: () => PNG_BYTES });

    const pageUrl = url("/purge");
    const seeded = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(viewer, transport) },
    );
    expect(seeded.card).not.toBeNull();
    const imageKey = seeded.card?.imageUrl?.replace("/media/", "");
    expect(imageKey && testStorageObjects.has(imageKey)).toBe(true);

    const purged = await call(
      appRouter.moderation.purgeLinkCard,
      { url: pageUrl, reason: "phishing preview" },
      { context: contextWithTransport(moderator, transport) },
    );
    expect(purged).toEqual({ url: pageUrl, purged: true });

    // Every post sharing the URL loses the preview…
    const after = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(viewer, transport) },
    );
    expect(after.card).toBeNull();

    // …the stored image object is gone…
    expect(imageKey && testStorageObjects.has(imageKey)).toBe(false);

    // …the row records the purge rather than deleting it (a deletion would be
    // refetched and the card would return)…
    const [row] = await db.select().from(linkCard).where(eq(linkCard.url, pageUrl));
    expect(row?.title).toBeNull();
    expect(row?.imageMediaPath).toBeNull();
    expect(row?.purgedAt).not.toBeNull();
    expect(row?.purgedBy).toBe(moderator.id);
    expect(row?.purgedReason).toBe("phishing preview");

    // …and no revalidation window re-opens it: aging the row past the window
    // still serves no card and refetches nothing.
    await db
      .update(linkCard)
      .set({ fetchedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(linkCard.url, pageUrl));
    const refetchAttempt = await call(
      appRouter.post.linkCard,
      { url: pageUrl },
      { context: contextWithTransport(viewer, transport) },
    );
    expect(refetchAttempt.card).toBeNull();
    expect(transport.htmlRequests).toBe(1);
  });

  it("refuses a caller below the moderation hierarchy, and a URL with no card", async () => {
    const user = await createTestUser();
    const moderator = await moderatorUser();

    await expect(
      call(
        appRouter.moderation.purgeLinkCard,
        { url: url("/unpurged"), reason: "no card to purge" },
        { context: contextFor(user) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      call(
        appRouter.moderation.purgeLinkCard,
        { url: url("/unpurged"), reason: "no card to purge" },
        { context: contextFor(moderator) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
