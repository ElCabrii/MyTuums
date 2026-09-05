/**
 * The IGDB client for the game-catalog sync (issue #314) — the repo's first
 * OAuth client-credentials consumer, so the patterns it wants (injectable
 * transport, one retry, pacing, deadline races) are lifted from the one
 * bounded outbound client that already exists, `./link-card-http.ts`.
 *
 * Fixed first-party hosts only (`api.igdb.com`, `id.twitch.tv`,
 * `images.igdb.com`), so none of the link-card SSRF machinery applies — there
 * is no author-supplied URL here to validate, only credentials and response
 * discipline:
 *
 * - **Pacing by construction.** Every outbound request — queries, token,
 *   covers — funnels through one serialized slot with at least
 *   `IGDB_MIN_REQUEST_INTERVAL_MS` between sends, staying under the ~4 req/s
 *   budget IGDB documents instead of reacting to 429s it could have avoided.
 * - **Exactly one retry.** 429 / 5xx / network / timeout earn a single paced
 *   retry (a 429's `Retry-After` honored, capped); a second failure throws,
 *   per the sync's fail-closed rule (issue Q28) — and costs nothing, because
 *   the next weekly run re-hydrates every game anyway (Q29).
 * - **Authentication failures are never retried**: a 401/403 from the API or
 *   the token endpoint is a credentials problem, and retrying it is just a
 *   slower way of failing.
 */
import { z } from "zod";
import {
  IGDB_API_ORIGIN,
  IGDB_COVER_TIMEOUT_MS,
  IGDB_IMAGE_BASE_URL,
  IGDB_MAX_COVER_BYTES,
  IGDB_MIN_REQUEST_INTERVAL_MS,
  IGDB_QUERY_TIMEOUT_MS,
  IGDB_RETRY_BACKOFF_MAX_MS,
  IGDB_RETRY_BACKOFF_MS,
  IGDB_TOKEN_EXPIRY_MARGIN_MS,
  IGDB_TOKEN_URL,
  type AllowedImageType,
} from "./constants.js";
import { sniffImageType } from "./post-image.js";

// The wire shapes, parsed where the bytes arrive — the one place IGDB's
// answers are trusted, and the only place they need forgiving (every field
// IGDB may omit is optional or nullable here; the sync's staging then works
// on the parsed domain types, not on `typeof` probes).
const igdbTokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

/** `/popularity_types` rows — the by-name resolution input (issue Q2). */
export const igdbPopularityTypeSchema = z.object({
  id: z.number(),
  name: z.string(),
});

/** `/popularity_primitives` rows, one page of the popularity scan. */
export const igdbPopularityPrimitiveSchema = z.object({
  game_id: z.number().nullable(),
  value: z.number(),
});

/**
 * `/games` hydration rows, with the inline sub-expansions the sync asks for
 * (`cover.image_id`, `genres.name`, `platforms.abbreviation`/`name`).
 */
export const igdbGameRowSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  summary: z.string().nullable().optional(),
  /** Unix seconds. */
  first_release_date: z.number().nullable().optional(),
  cover: z.object({ image_id: z.string().nullable().optional() }).nullable().optional(),
  genres: z
    .array(z.object({ name: z.string().nullable().optional() }))
    .nullable()
    .optional(),
  platforms: z
    .array(
      z.object({
        abbreviation: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
});

export type IgdbPopularityType = z.infer<typeof igdbPopularityTypeSchema>;
export type IgdbPopularityPrimitive = z.infer<typeof igdbPopularityPrimitiveSchema>;
export type IgdbGameRow = z.infer<typeof igdbGameRowSchema>;

/** Why a request failed — the entrypoint logs the reason, not a stack trace. */
export type IgdbFailureReason =
  "unauthorized" | "rate_limited" | "server" | "network" | "timeout" | "bad_response";

export class IgdbError extends Error {
  readonly reason: IgdbFailureReason;
  readonly status?: number;
  readonly endpoint?: string;
  /** A 429's `Retry-After` in ms, when the server sent one. */
  readonly retryAfterMs?: number;

  constructor(
    reason: IgdbFailureReason,
    message: string,
    options?: { status?: number; endpoint?: string; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "IgdbError";
    this.reason = reason;
    this.status = options?.status;
    this.endpoint = options?.endpoint;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * One seam for the whole client, like `LinkFetchTransport` — tests drive
 * authentication, retry and pacing decisions with a fake and never reach the
 * network. Plain `string` URLs because every URL here is one of three
 * constants plus a path, never caller-supplied.
 */
export interface IgdbTransport {
  fetch(
    url: string,
    init: {
      method: "POST" | "GET";
      headers: Record<string, string>;
      body?: string;
      signal: AbortSignal;
    },
  ): Promise<Response>;
}

/** The production transport: the platform `fetch`, nothing else. */
export function createIgdbTransport(): IgdbTransport {
  return {
    fetch: (url, init) =>
      fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      }),
  };
}

export interface IgdbClient {
  /**
   * Runs one Apicalypse query against `/v4/<endpoint>` and returns its rows
   * as parsed JSON, UNVALIDATED — callers validate with the exported
   * `igdb*Schema`s at their boundary, so the client stays generic over
   * endpoints and the wire contract lives in one schema per row type.
   */
  query(endpoint: string, apicalypse: string): Promise<unknown[]>;
  /**
   * Downloads one cover at `t_cover_big` size, sniffs the true format from
   * the bytes. Throws on any failure — a cover is per-game tolerance, not
   * run tolerance (issue Q28: a failed cover keeps the old one), and that
   * decision belongs to the sync, not to this client.
   */
  fetchCoverImage(imageId: string): Promise<{ bytes: Uint8Array; contentType: AllowedImageType }>;
}

/**
 * Reads a response body and schema-parses it at the boundary — no function
 * here hands raw JSON onward. Any read or shape failure is `bad_response`.
 */
async function parseBody<Row>(
  response: Response,
  schema: z.ZodType<Row>,
  failure: string,
): Promise<Row> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new IgdbError("bad_response", failure);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new IgdbError("bad_response", failure);
  return parsed.data;
}

export function createIgdbClient(config: {
  clientId: string;
  clientSecret: string;
  transport?: IgdbTransport;
  /** Injectable for tests so pacing never slows them down; default the constant. */
  minRequestIntervalMs?: number;
  /** Same for the retry backoff. */
  retryBackoffMs?: number;
}): IgdbClient {
  const transport = config.transport ?? createIgdbTransport();
  const interval = config.minRequestIntervalMs ?? IGDB_MIN_REQUEST_INTERVAL_MS;
  const backoffMs = config.retryBackoffMs ?? IGDB_RETRY_BACKOFF_MS;

  // The pacing slot: every request awaits the previous one, then the
  // remainder of the interval since the last send. `lastSentAt` is set at
  // SEND time (not completion) so a slow response cannot compress the next
  // request into the same window.
  let lastSentAt = 0;
  let queue: Promise<unknown> = Promise.resolve();
  function schedule<Row>(task: () => Promise<Row>): Promise<Row> {
    const run = queue.then(async () => {
      const wait = lastSentAt + interval - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastSentAt = Date.now();
      return task();
    });
    queue = run.catch(() => {});
    return run;
  }

  /** One request against the deadline clock — "timeout" wins over any late failure. */
  async function send(
    url: string,
    init: { method: "POST" | "GET"; headers: Record<string, string>; body?: string },
    timeoutMs: number,
    endpoint: string,
  ): Promise<Response> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => {
        // Resolve before aborting: the abort makes a cooperative transport
        // reject in the same tick, and whichever settles first wins the race.
        resolve("timeout");
        controller.abort();
      }, timeoutMs);
    });

    const fetchPromise = transport.fetch(url, { ...init, signal: controller.signal });
    // A transport that loses the race can still reject afterwards; the race
    // never observes it, and the no-op catch keeps it unhandled-rejection-free.
    fetchPromise.catch(() => {});

    try {
      const outcome = await Promise.race([fetchPromise, timeoutPromise]);
      if (outcome === "timeout") {
        throw new IgdbError("timeout", `${endpoint} did not answer within ${timeoutMs}ms`, {
          endpoint,
        });
      }
      return outcome;
    } catch (error) {
      if (error instanceof IgdbError) throw error;
      throw new IgdbError("network", `${endpoint} request failed: ${String(error)}`, { endpoint });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Throws the failure a non-OK response represents; returns nothing on OK. */
  function refuse(response: Response, endpoint: string): void {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new IgdbError("unauthorized", `${endpoint} refused the credentials`, {
        status: response.status,
        endpoint,
      });
    }
    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      throw new IgdbError("rate_limited", `${endpoint} is rate limited`, {
        status: 429,
        endpoint,
        retryAfterMs:
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : undefined,
      });
    }
    if (response.status >= 500) {
      throw new IgdbError("server", `${endpoint} answered ${response.status}`, {
        status: response.status,
        endpoint,
      });
    }
    throw new IgdbError("bad_response", `${endpoint} answered ${response.status}`, {
      status: response.status,
      endpoint,
    });
  }

  function isRetryable(error: IgdbError): boolean {
    return (
      error.reason === "rate_limited" ||
      error.reason === "server" ||
      error.reason === "network" ||
      error.reason === "timeout"
    );
  }

  /** The one-retry envelope: attempt, decide, retry once, then throw. */
  async function withRetry(endpoint: string, task: () => Promise<Response>): Promise<Response> {
    for (let tries = 0; ; tries++) {
      try {
        const response = await task();
        refuse(response, endpoint);
        return response;
      } catch (error) {
        const failure =
          error instanceof IgdbError
            ? error
            : new IgdbError("network", `${endpoint} failed: ${String(error)}`, { endpoint });
        if (tries > 0 || !isRetryable(failure)) throw failure;
        const backoff = Math.min(failure.retryAfterMs ?? backoffMs, IGDB_RETRY_BACKOFF_MAX_MS);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  // The token, fetched lazily and cached until shortly before it expires.
  let cachedToken: { accessToken: string; expiresAt: number } | null = null;
  async function accessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;
    const url = `${IGDB_TOKEN_URL}?client_id=${encodeURIComponent(config.clientId)}&client_secret=${encodeURIComponent(config.clientSecret)}&grant_type=client_credentials`;
    const response = await send(
      url,
      { method: "POST", headers: {} },
      IGDB_QUERY_TIMEOUT_MS,
      "token",
    );
    refuse(response, "token");
    const token = await parseBody(
      response,
      igdbTokenSchema,
      "Token endpoint returned no access_token/expires_in",
    );
    cachedToken = {
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000 - IGDB_TOKEN_EXPIRY_MARGIN_MS,
    };
    return cachedToken.accessToken;
  }

  return {
    async query(endpoint: string, apicalypse: string): Promise<unknown[]> {
      const response = await schedule(() =>
        withRetry(endpoint, async () => {
          const token = await accessToken();
          return send(
            `${IGDB_API_ORIGIN}/v4/${endpoint}`,
            {
              method: "POST",
              headers: {
                "Client-ID": config.clientId,
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
              },
              body: apicalypse,
            },
            IGDB_QUERY_TIMEOUT_MS,
            endpoint,
          );
        }),
      );

      // `z.array(z.unknown())` keeps this generic over endpoints: the row
      // schema is the caller's boundary, this one only insists on an array.
      return await parseBody(
        response,
        z.array(z.unknown()),
        `${endpoint} returned a non-array body`,
      );
    },

    async fetchCoverImage(
      imageId: string,
    ): Promise<{ bytes: Uint8Array; contentType: AllowedImageType }> {
      const endpoint = `cover ${imageId}`;
      const response = await schedule(() =>
        withRetry(endpoint, () =>
          send(
            `${IGDB_IMAGE_BASE_URL}/t_cover_big/${encodeURIComponent(imageId)}.jpg`,
            { method: "GET", headers: { Accept: "image/jpeg, image/png" } },
            IGDB_COVER_TIMEOUT_MS,
            endpoint,
          ),
        ),
      );

      // Capped read, chunk by chunk — the link-card reader's reasoning: a
      // Covers are bounded reads from IGDB's own CDN (a fixed first-party
      // host, not author-supplied content), so a whole-body read with the cap
      // applied to the result is enough discipline — and it sidesteps the
      // stream reader's `any`-typed chunks entirely.
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > IGDB_MAX_COVER_BYTES) {
        throw new IgdbError("bad_response", `${endpoint} exceeds the byte cap`, { endpoint });
      }

      // Sniffed ground truth over any content-type header: what gets stored
      // is what the bytes are, and non-image bytes are refused outright.
      const sniffed = sniffImageType(bytes);
      if (!sniffed) {
        throw new IgdbError("bad_response", `${endpoint} is not a recognizable image`, {
          endpoint,
        });
      }
      return { bytes, contentType: sniffed };
    },
  };
}
