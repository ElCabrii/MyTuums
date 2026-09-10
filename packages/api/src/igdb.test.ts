import { describe, expect, it } from "vitest";
import { createIgdbClient, IgdbError, type IgdbTransport } from "./igdb.js";

/**
 * The wire contract of the sync's only external dependency, pinned against a
 * fake transport — the real IGDB is reached by exactly one thing, the local
 * `pnpm games:sync` against real credentials, and never by CI. One
 * behavioral fact per test; timing is deliberately unpinned (the pacing slot
 * runs with a zero interval here, and no test asserts how long anything
 * took).
 */

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A transport whose responses are scripted per call, in order. */
function scriptedTransport(responses: Array<(call: RecordedCall) => Response>) {
  const calls: RecordedCall[] = [];
  let next = 0;
  const transport: IgdbTransport = {
    // `Promise.resolve` around a synchronous script — the repo's fake-transport
    // shape (see link-card-http.test.ts): nothing here needs the event loop.
    fetch: (url, init) =>
      Promise.resolve(
        (() => {
          const call = { url, method: init.method, headers: init.headers, body: init.body };
          calls.push(call);
          const script =
            responses[next++] ?? failWith(new Error(`unexpected extra request: ${url}`));
          return script(call);
        })(),
      ),
  };
  return { transport, calls };
}

/** A script step that rejects the transport call outright (network class). */
function failWith(error: Error): (call: RecordedCall) => Response {
  return () => {
    throw error;
  };
}

const TOKEN_BODY = JSON.stringify({ access_token: "token-1", expires_in: 3600 });

/** Wraps row arrays — every `/v4/` endpoint answers with an array. */
function json(rows: readonly unknown[], status = 200): Response {
  return new Response(JSON.stringify(rows), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(transport: IgdbTransport) {
  return createIgdbClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    transport,
    minRequestIntervalMs: 0,
    retryBackoffMs: 1,
  });
}

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const GAMES_URL = "https://api.igdb.com/v4/games";
const TOP_GAMES_URL = "https://api.twitch.tv/helix/games/top?first=100";

describe("createIgdbClient", () => {
  it("fetches the token once and attaches credentials to every query", async () => {
    const { transport, calls } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => json([{ id: 1, name: "DOOM" }]),
      () => json([{ id: 2, name: "Hades" }]),
    ]);

    const igdb = client(transport);
    await expect(igdb.query("games", "fields name;")).resolves.toEqual([{ id: 1, name: "DOOM" }]);
    await expect(igdb.query("games", "fields name;")).resolves.toEqual([{ id: 2, name: "Hades" }]);

    const tokenCalls = calls.filter((call) => call.url.startsWith(TOKEN_URL));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].url).toContain("grant_type=client_credentials");
    for (const call of calls.filter((call) => call.url === GAMES_URL)) {
      expect(call.headers["Client-ID"]).toBe("client-id");
      expect(call.headers.Authorization).toBe("Bearer token-1");
      expect(call.body).toBe("fields name;");
    }
  });

  it("fails immediately on a 401 from the API — one attempt, no retry", async () => {
    const { transport, calls } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => new Response("nope", { status: 401 }),
    ]);

    await expect(client(transport).query("games", "fields name;")).rejects.toMatchObject({
      reason: "unauthorized",
    });
    expect(calls.filter((call) => call.url === GAMES_URL)).toHaveLength(1);
  });

  it("fails when two consecutive 5xx answers exhaust the single retry", async () => {
    const { transport, calls } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => new Response("boom", { status: 502 }),
      () => new Response("boom", { status: 502 }),
    ]);

    await expect(client(transport).query("games", "fields name;")).rejects.toMatchObject({
      reason: "server",
    });
    expect(calls.filter((call) => call.url === GAMES_URL)).toHaveLength(2);
  });

  it("succeeds when the single retry lands after a 5xx", async () => {
    const { transport, calls } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => new Response("boom", { status: 503 }),
      () => json([{ id: 1 }]),
    ]);

    await expect(client(transport).query("games", "fields name;")).resolves.toEqual([{ id: 1 }]);
    expect(calls.filter((call) => call.url === GAMES_URL)).toHaveLength(2);
  });

  it("succeeds when the single retry lands after a 429", async () => {
    const { transport, calls } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      () => json([{ id: 1 }]),
    ]);

    await expect(client(transport).query("games", "fields name;")).resolves.toEqual([{ id: 1 }]);
    expect(calls.filter((call) => call.url === GAMES_URL)).toHaveLength(2);
  });

  it("fails without sending any query when the token endpoint refuses the credentials", async () => {
    const { transport, calls } = scriptedTransport([() => new Response("bad", { status: 401 })]);

    await expect(client(transport).query("games", "fields name;")).rejects.toMatchObject({
      reason: "unauthorized",
    });
    expect(calls.filter((call) => call.url === GAMES_URL)).toHaveLength(0);
  });

  it("reports a 200 with a non-JSON body as bad_response", async () => {
    const { transport } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => new Response("<html>tourism portal</html>", { status: 200 }),
    ]);

    await expect(client(transport).query("games", "fields name;")).rejects.toMatchObject({
      reason: "bad_response",
    });
  });

  it("treats a transport rejection as a retryable network failure", async () => {
    const { transport, calls } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      failWith(new TypeError("fetch failed")),
      () => json([{ id: 1 }]),
    ]);

    await expect(client(transport).query("games", "fields name;")).resolves.toEqual([{ id: 1 }]);
    expect(calls.filter((call) => call.url === GAMES_URL)).toHaveLength(2);
  });
});

describe("createIgdbClient.listTopGamesPage", () => {
  const page = (entries: readonly unknown[], cursor?: string) =>
    new Response(JSON.stringify({ data: entries, pagination: cursor ? { cursor } : {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const entry = (igdbId: string, id = `tw-${igdbId}`) => ({
    id,
    name: `Game ${igdbId}`,
    box_art_url: `https://static-cdn.jtvnw.net/ttv-boxart/${id}-{width}x{height}.jpg`,
    igdb_id: igdbId,
  });

  it("requests first=100 with the shared credentials and returns the entries plus the cursor", async () => {
    const { transport, calls } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => page([entry("10"), entry("20")], "cursor-1"),
    ]);

    const result = await client(transport).listTopGamesPage();

    expect(result).toEqual({
      games: [entry("10"), entry("20")],
      cursor: "cursor-1",
    });
    const helixCalls = calls.filter((call) => call.url.startsWith(TOP_GAMES_URL));
    expect(helixCalls).toHaveLength(1);
    expect(helixCalls[0].url).toBe(TOP_GAMES_URL);
    expect(helixCalls[0].method).toBe("GET");
    expect(helixCalls[0].headers["Client-ID"]).toBe("client-id");
    expect(helixCalls[0].headers.Authorization).toBe("Bearer token-1");
  });

  it("passes the previous cursor as after on the next page", async () => {
    const { transport, calls } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => page([entry("10")], "cursor-1"),
      () => page([entry("20")]),
    ]);

    const igdb = client(transport);
    const first = await igdb.listTopGamesPage();
    const second = await igdb.listTopGamesPage(first.cursor);

    expect(second).toEqual({ games: [entry("20")], cursor: undefined });
    expect(calls.map((call) => call.url)).toContain(`${TOP_GAMES_URL}&after=cursor-1`);
  });

  it("keeps entries with an empty igdb_id — skipping them is the sync's decision, not the client's", async () => {
    const { transport } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () =>
        page([
          {
            id: "508093",
            name: "Just Chatting",
            box_art_url: "https://example.com/jc.jpg",
            igdb_id: "",
          },
        ]),
    ]);

    const result = await client(transport).listTopGamesPage();
    expect(result.games).toHaveLength(1);
    expect(result.games[0].igdb_id).toBe("");
  });

  it("normalizes a numeric igdb_id to its string form at the wire boundary", async () => {
    const { transport } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () =>
        page([
          {
            id: "tw-10",
            name: "Game 10",
            box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/tw-10-{width}x{height}.jpg",
            igdb_id: 10,
          },
        ]),
    ]);

    const result = await client(transport).listTopGamesPage();
    expect(result.games[0].igdb_id).toBe("10");
  });

  it("fails immediately on a 401 from Helix — one attempt, no retry", async () => {
    const { transport, calls } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => new Response("nope", { status: 401 }),
    ]);

    await expect(client(transport).listTopGamesPage()).rejects.toMatchObject({
      reason: "unauthorized",
    });
    expect(calls.filter((call) => call.url.startsWith(TOP_GAMES_URL))).toHaveLength(1);
  });

  it("succeeds when the single retry lands after a 5xx", async () => {
    const { transport, calls } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => new Response("boom", { status: 503 }),
      () => page([entry("10")]),
    ]);

    await expect(client(transport).listTopGamesPage()).resolves.toMatchObject({
      games: [entry("10")],
    });
    expect(calls.filter((call) => call.url.startsWith(TOP_GAMES_URL))).toHaveLength(2);
  });

  it("reports a page in an unexpected shape as bad_response", async () => {
    const { transport } = scriptedTransport([
      () => new Response(TOKEN_BODY, { status: 200 }),
      () => json([{ id: 1 }]),
    ]);

    await expect(client(transport).listTopGamesPage()).rejects.toMatchObject({
      reason: "bad_response",
    });
  });
});
describe("createIgdbClient.fetchCoverImage", () => {
  // FF D8 FF E0 — the JPEG signature `sniffImageType` keys on; the client
  // stores what the bytes ARE, not what a header claims.
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  function coverResponse(bytes: Uint8Array, status = 200): Response {
    return new Response(bytes, { status, headers: { "content-type": "image/jpeg" } });
  }

  it("downloads a cover and sniffs its true format from the bytes", async () => {
    const { transport, calls } = scriptedTransport([() => coverResponse(JPEG)]);

    const cover = await client(transport).fetchCoverImage("co1r7e");
    expect(cover.contentType).toBe("image/jpeg");
    expect([...cover.bytes]).toEqual([...JPEG]);
    expect(calls[0].url).toBe("https://images.igdb.com/igdb/image/upload/t_cover_big/co1r7e.jpg");
  });

  it("refuses non-image bytes whatever the content-type header says", async () => {
    const { transport } = scriptedTransport([
      () => coverResponse(new TextEncoder().encode("<svg/>")),
    ]);

    await expect(client(transport).fetchCoverImage("co1r7e")).rejects.toMatchObject({
      reason: "bad_response",
    });
  });

  it("refuses a cover that exceeds the byte cap", async () => {
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1).fill(0xff);
    oversized.set([0xff, 0xd8, 0xff, 0xe0]);
    const { transport } = scriptedTransport([() => coverResponse(oversized)]);

    await expect(client(transport).fetchCoverImage("co1r7e")).rejects.toMatchObject({
      reason: "bad_response",
    });
  });

  it("does not retry a gone cover (404)", async () => {
    const { transport, calls } = scriptedTransport([() => coverResponse(JPEG, 404)]);

    await expect(client(transport).fetchCoverImage("co1r7e")).rejects.toBeInstanceOf(IgdbError);
    expect(calls).toHaveLength(1);
  });
});
