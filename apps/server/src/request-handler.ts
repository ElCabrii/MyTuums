import {
  IncomingMessage,
  type IncomingHttpHeaders,
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
} from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  RPC_MAX_BODY_BYTES,
  RPC_SMALL_BODY_BYTES,
  SIGNED_OUT_PATHS,
} from "@my-tuums/api/constants";
import { isBrandingHostRequest } from "./branding-host.js";
import { normalizeObservedError, type ErrorObserver } from "./error-observation.js";
import { createRequestId, pathnameOf } from "./observability.js";

/** The response surface the routing tree itself uses. */
export interface RequestResponse {
  readonly headersSent: boolean;
  writeHead(status: number, headers?: OutgoingHttpHeaders): this;
  end(body?: string): this;
  destroy(error?: Error): this;
  setHeader(name: string, value: number | string | readonly string[]): this;
  getHeader(name: string): OutgoingHttpHeader | undefined;
}

/** The request surface Better Auth's node adapter reads; the replayed body stream satisfies it. */
export interface AuthRequestSurface extends NodeJS.ReadableStream {
  headers: IncomingHttpHeaders;
  method?: string;
  url?: string;
  socket: Socket;
  httpVersionMajor: number;
}

/** One session-store read, preserving the difference between signed out and unavailable. */
export type SessionLookup =
  { kind: "authenticated"; userId: string } | { kind: "anonymous" } | { kind: "unavailable" };

/**
 * Authentication payloads are small JSON/form requests, never media uploads.
 * Keep this budget well below the RPC upload ceiling so an unauthenticated
 * caller cannot make Better Auth buffer an upload-sized body before it can
 * apply endpoint validation or rate limiting.
 */
export const AUTH_MAX_BODY_BYTES = 1024 * 1024;

/**
 * The stand-ins `createRequestHandler` routes through, injected so the
 * routing tree can be unit-tested with none of them real.
 */
export interface RequestHandlerDeps {
  /** `SELECT 1` — throws if Postgres is unreachable. */
  pingDb: () => Promise<void>;
  /** BetterAuth's node handler for everything under `/api/auth`. */
  authNodeHandler: (req: AuthRequestSurface, res: RequestResponse) => Promise<void> | void;
  /**
   * Resolves the oRPC context and dispatches to the router for everything
   * under `/rpc`. Bundled as one callback — rather than passed apart as
   * `createContext` + `handler.handle` — so this module doesn't need to know
   * about sessions, client IPs, or oRPC at all; it only needs to know whether
   * a `/rpc`-prefixed request was matched.
   */
  handleRpc: (req: IncomingMessage, res: RequestResponse) => Promise<{ matched: boolean }>;
  /**
   * Turns a `/media/<key>` object key into a redirect target, plus — when a
   * key's redirect may be stored — the Cache-Control to send it with, and
   * `null` when it should 404. Only ever called for a request that already
   * passed the session gate below, and always with the authenticated viewer's
   * id: every key — post and profile alike — is authorized per viewer by the
   * resolver (see `createMediaResolver` in `@my-tuums/api`), so there is no
   * path where this module names an object without saying who is asking.
   *
   * Injected rather than imported for the same reason the three above are:
   * this module's job is the routing decision, and a unit test of it should
   * not need a bucket or a database.
   */
  resolveMediaUrl: (
    key: string,
    viewerId: string,
  ) => Promise<{ url: string; cacheControl?: string } | null>;
  /**
   * Serves the built web app, when this deployment bundles it.
   *
   * Last in the chain and injected like the rest: in dev it is `noStaticFiles`
   * (Vite serves the app and proxies here), and in production it is a handler
   * over `WEB_DIST`. Reporting `{ served: false }` rather than writing a 404
   * itself keeps the 404 in one place.
   */
  serveStatic: (req: IncomingMessage, res: RequestResponse) => Promise<{ served: boolean }>;
  /**
   * Serves the built branding site (apps/branding), when this deployment
   * bundles it — same shape and same injection reasons as `serveStatic`
   * above, but reached only for requests whose Host is the branding hostname
   * (see ./branding-host.ts). `noStaticFiles` in dev, where the branding app
   * runs under its own Vite server like the SPA does.
   */
  serveBranding: (req: IncomingMessage, res: RequestResponse) => Promise<{ served: boolean }>;
  /**
   * Resolves both session validity and viewer identity through one
   * `auth.api.getSession` call. The cookie pre-check used by the page and
   * `/media` gates avoids paying for this on every anonymous request.
   *
   * Injected rather than imported for the same reason as the deps above: this
   * module stays free of `@my-tuums/auth`, so its unit tests need no database
   * and no real session store. `unavailable` deliberately differs from an
   * anonymous session: the page gate fails open, while every media request
   * fails closed — without an authenticated viewer there is no one to
   * authorize the object against.
   */
  resolveSession: (req: IncomingMessage) => Promise<SessionLookup>;
  /**
   * Called when the top-level safety net catches an unhandled exception. The
   * routing tree still owns the 500 response; the shared error-observation
   * policy owns logging, client-abort filtering, and reporting.
   */
  observeError: ErrorObserver;
}

const MEDIA_PREFIX = "/media/";

/**
 * The session cookie BetterAuth sets. Hardcoded rather than imported from
 * `@my-tuums/auth` — this module is deliberately free of that dependency (its
 * unit tests stand in for the auth handler) — and packages/auth never
 * overrides the default name.
 *
 * This is a genuine correctness dependency, not just an optimization: the
 * page gate below short-circuits to "redirect, don't bother asking the
 * session store" whenever this returns `false`, so a name mismatch would 302
 * *every* visitor to `/login` — signed in or not — the same failure mode the
 * old `/`-only version of this check had. If the upstream default ever
 * changes, this must change with it.
 *
 * The name carries a `__Secure-` prefix whenever BetterAuth serves over
 * HTTPS, i.e. every production request; plain HTTP (dev, localhost) gets the
 * bare name. The check below mirrors BetterAuth's own `getCookie` fallback
 * (`parsedCookie.get(`__Secure-${name}`) ?? parsedCookie.get(name)`) so a live
 * cookie in either shape is recognised.
 */
const SESSION_COOKIE_NAME = "better-auth.session_token";

function hasSessionCookie(cookieHeader: string | undefined): boolean {
  return (
    cookieHeader?.split(";").some((part) => {
      const name = part.trim();
      return (
        name.startsWith(`${SESSION_COOKIE_NAME}=`) ||
        name.startsWith(`__Secure-${SESSION_COOKIE_NAME}=`)
      );
    }) ?? false
  );
}

function declaredContentLength(req: IncomingMessage): number | null {
  // Content-Length is a non-repeatable header, so Node's types expose it as a
  // single string (never an array) — no representation check is needed.
  const value = req.headers["content-length"];
  if (!value || value.trim() === "") return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

/**
 * Whether the body arrives in chunks (`Transfer-Encoding`), and therefore with
 * no Content-Length any gate could compare. The header is hop-by-hop and
 * repeatable per RFC 9112, so Node may hand it over as an array — normalize
 * before matching. A request with neither this header nor a usable declared
 * length carries no body at all (a bare GET), which is why the pre-auth gate
 * keys on this rather than on "Content-Length absent".
 */
function isChunkedRequestBody(req: IncomingMessage): boolean {
  const value = req.headers["transfer-encoding"];
  const encoding = Array.isArray(value) ? value.join(",") : (value ?? "");
  return encoding.toLowerCase().includes("chunked");
}

/**
 * The wire path of the app's ONE anonymous RPC procedure — `appealOpen` in
 * `moderationRouter` (packages/api). oRPC addresses a procedure by its router
 * path joined with `/`, NOT the dotted name the client code reads, so this is
 * `/rpc/moderation/appealOpen`. Every other `/rpc` procedure is session-gated,
 * so an anonymous caller has no legitimate use for a body above
 * `RPC_SMALL_BODY_BYTES` — except here, where the token is the capability and
 * the person is not signed in by construction.
 *
 * The literal lives in this module for the same reason `/api/auth` and `/rpc`
 * do: this file is deliberately free of `@my-tuums/api`'s router (its unit
 * tests stand it in), so the path cannot be imported from the router that
 * defines it. Judge the gate on the CANONICAL path, never the raw URL: dot
 * segments and a trailing slash must not spell a way around the session
 * demand, and anything that fails to canonicalise is not a legitimate appeal
 * and falls to that demand, which is the closed direction.
 */
const RPC_APPEAL_OPEN_PATH = "/rpc/moderation/appealOpen";

/**
 * The most `/rpc` dispatches whose body may buffer past `RPC_SMALL_BODY_BYTES`
 * at one time. This is the backpressure that bounds how many large bodies can
 * be buffering at once — and after the pre-auth gate only an AUTHENTICATED
 * caller can have one in flight at all, so the worst case this cap holds is a
 * set of authenticated sessions streaming `RPC_MAX_BODY_BYTES`-sized bodies
 * simultaneously. Small JSON bodies are deliberately outside the cap: each is
 * bounded by `RPC_SMALL_BODY_BYTES` itself, and counting them here would make
 * ordinary read traffic answer 503 under modest concurrency while bounding
 * nothing the per-body limit does not already bound.
 *
 * A request refused here is a 503 — the standard answer a busy server gives
 * an overload condition — and the web client treats 5xx as retryable.
 */
export const MAX_RPC_IN_FLIGHT = 25;

/**
 * Drain a rejected request without retaining its bytes. Keeping the socket
 * readable lets Node finish the response cleanly on keep-alive connections;
 * the one-shot error listener prevents a late client disconnect from becoming
 * an unhandled process-level error after we have already sent 413.
 */
function drainRejectedRequest(req: IncomingMessage): void {
  if (!(req instanceof Readable)) return;
  req.once("error", () => undefined);
  req.resume();
}

/**
 * Read an auth request once, retaining at most `limit` bytes. Better Auth's
 * Node adapter consumes the IncomingMessage itself, so attaching a counting
 * listener and then handing the same stream to it would create competing
 * consumers. Reading first and replaying a bounded buffer through a
 * PassThrough gives the adapter one ordinary stream to consume.
 */
async function readAuthBody(
  req: IncomingMessage,
  limit: number,
): Promise<{ body: Buffer; exceeded: boolean } | null> {
  if (req.method === "GET" || req.method === "HEAD" || !(req instanceof Readable)) return null;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      resolve({ body: Buffer.concat(chunks, total), exceeded: false });
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total <= limit) {
        chunks.push(bytes);
        return;
      }

      // The limit is known to have been crossed; do not wait for an attacker
      // to finish sending the rest of an unbounded chunked body. Remove the
      // retaining listener, keep draining in flowing mode, and resolve now so
      // the caller can send 413 immediately. The error listener remains until
      // the socket finishes so an abort during the drain is harmless.
      req.off("data", onData);
      req.off("end", onEnd);
      req.once("error", () => undefined);
      req.resume();
      resolve({ body: Buffer.concat(chunks, limit), exceeded: true });
    };
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };

    req.on("error", onError);
    req.on("end", onEnd);
    req.on("data", onData);
  });
}

/** Replays a bounded body while preserving the request metadata Better Auth reads. */
function requestWithBody(req: IncomingMessage, body: Buffer): AuthRequestSurface {
  // A PassThrough rather than a second IncomingMessage: the latter registers
  // itself against the live socket and would race the real request for the
  // connection's stream events.
  const stream = new PassThrough();
  stream.end(body);
  return Object.assign(stream, {
    headers: req.headers,
    method: req.method,
    url: req.url,
    socket: req.socket,
    httpVersionMajor: req.httpVersionMajor,
  });
}

/**
 * The path of a request, without the query string.
 *
 * `req.url` is a raw target, so it carries `?...` and is percent-encoded. The
 * base is a throwaway — only `pathname` is read — and `decodeURIComponent` is
 * what turns `%2F` and friends back into the characters the key validator
 * actually needs to see, rather than letting an encoded separator slip past a
 * check performed on the encoded form.
 */
function mediaKeyOf(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, "http://media.invalid").pathname);
  } catch {
    // A malformed percent-escape throws; that is a bad request, not a key.
    return null;
  }

  if (!pathname.startsWith(MEDIA_PREFIX)) return null;
  const key = pathname.slice(MEDIA_PREFIX.length);
  return key.length > 0 ? key : null;
}

/**
 * The page gate's path check, deliberately NOT percent-decoded (unlike
 * `mediaKeyOf` above and `canonicalizePathname` below). `SIGNED_OUT_PATHS` is
 * compared against the raw pathname, so an encoded path like `/%6Cogin` —
 * which decodes to `/login` but is not the literal string `"/login"` — fails
 * the allowlist match and gets redirected rather than let through. Failing
 * closed is the right direction for a gate; the worst case is an odd path
 * getting redirected to `/login` unnecessarily, never a signed-out visitor
 * reaching a page they shouldn't.
 *
 * Returns `null` for a malformed target, same as `mediaKeyOf` — a bad request
 * is not a page this gate has an opinion on either.
 */
function pageGatePathname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl, "http://page.invalid").pathname;
  } catch {
    return null;
  }
}

/**
 * The fully-normalized path of a request: percent-decoded, dot segments
 * resolved, repeated slashes collapsed.
 *
 * This is the form an HTTP router — better-auth included — effectively routes
 * on, so a prefix check that runs on the RAW url (see the admin denylist
 * below) can be danced around by encoding: `%2F` for a slash, `%2e%2e` for
 * `..`, doubled slashes, or a missing trailing slash all change the literal
 * string without changing the route. Comparing against this form instead
 * means whatever the request decodes to is what is judged.
 *
 * Decoding is applied BEFORE dot-segment resolution, which is the order that
 * catches an encoded `..`: `new URL` only recognizes literal `.`/`..` when it
 * normalizes, so `%2e%2e` must be a character first.
 *
 * Returns `null` for a malformed target, same as `mediaKeyOf` — the caller
 * decides whether a malformed URL is closed or passed through.
 */
function canonicalizePathname(rawUrl: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(new URL(rawUrl, "http://canonical.invalid").pathname);
  } catch {
    return null;
  }

  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * Builds the routing decision tree `index.ts` hands to `createServer`: health
 * check, the `/api/auth` and `/rpc` prefixes, the 404 fallback, and the
 * top-level exception safety net.
 *
 * Pulled out from `index.ts` specifically so this tree — which is entirely
 * our own logic, not a third-party library's — can be unit tested with
 * stand-ins for the six dependencies it routes through, none of which need
 * to be real: no Postgres, no BetterAuth, no oRPC router, no listening
 * socket. What is NOT covered here is CORS — that is `CORSPlugin`'s behaviour
 * on the real `RPCHandler`, which is wire-level HTTP behaviour of a
 * third-party plugin, not a decision this module makes. It stays covered by
 * the Playwright `api` project instead, which is the layer actually
 * positioned to observe response headers over a real connection.
 */
export function createRequestHandler(deps: RequestHandlerDeps) {
  // How many `/rpc` dispatches with a body over the small-body line are
  // currently in flight — the ones the admission cap exists to bound. Owned
  // by this closure so every handler instance shares one counter; a
  // per-instance counter would admit `MAX_RPC_IN_FLIGHT` per instance and the
  // cap would scale with the replica count instead of holding per process.
  // See `MAX_RPC_IN_FLIGHT` above for what the cap is for.
  let rpcInFlight = 0;

  return async function handleRequest(req: IncomingMessage, res: RequestResponse): Promise<void> {
    // Every request gets an identity before any routing branch runs, so
    // whatever the tree serves — health, auth, rpc, media, page, 404, or
    // the 500 safety net — carries the same `x-request-id` on the way out
    // that its log lines carry, and the access log (observability.ts) reads
    // the header back when the response finishes. The injected handlers
    // (auth, rpc, static) write their own responses, but the header was
    // already set here, so it lands on theirs too.
    const requestId = createRequestId();
    res.setHeader("x-request-id", requestId);

    try {
      // Checked first, above /rpc and /api/auth, so probes don't pay for
      // oRPC route matching or a session lookup. Exact match rather than a
      // prefix: `/health?x=1` is not a health check, it's an unrecognised
      // route, and should 404 like one.
      if (req.url === "/health") {
        try {
          await deps.pingDb();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } catch (error) {
          console.error(`[${requestId}] Health check failed: database unreachable:`, error);
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", reason: "database unreachable" }));
        }
        return;
      }

      // The admin plugin's own endpoints (`/api/auth/admin/*`) are
      // deliberately unreachable. They gate on better-auth's `adminRoles`
      // option only, which cannot express the app's staff-vs-admin hierarchy
      // (see docs/product.md), and every moderation action — appointing,
      // removing a post, suspending, banning — must go through the `/rpc`
      // procedures
      // instead, which enforce that hierarchy AND write the audit log. A 404
      // here keeps the enforcement in one place: whatever the plugin's own
      // gate would have admitted (or, worse, admitted by role alone) is never
      // reachable, so the hierarchy cannot be bypassed by calling the plugin's
      // endpoints directly.
      //
      // Checked before the `/api/auth` pass-through below, which is why this
      // prefix needs no other routing here.
      //
      // The check runs on the CANONICALIZED path (`canonicalizePathname`), not
      // the raw url: better-auth decodes and normalizes before it routes, so
      // an encoded slash (`admin%2Fban-user`), an encoded dot segment
      // (`admin%2f..%2f..%2f..` canceling back onto the prefix), a doubled
      // slash, or the bare `/api/auth/admin` with no trailing slash would each
      // fall past a raw string compare and reach the plugin's own gate.
      // Comparing the decoded, normalized form closes every spelling of an
      // admin route — and, because the canonical form is what is judged,
      // `/api/auth/admin/../get-session` (canonical `/api/auth/get-session`)
      // passes through to the auth handler exactly as it would to better-auth.
      // The raw compare survives only as the fallback for the one input
      // canonicalization refuses — a malformed percent-escape that still
      // literally names an admin path — so that case fails closed too.
      const canonicalPath = canonicalizePathname(req.url ?? "");
      const isAdminRoute =
        canonicalPath === null
          ? req.url?.startsWith("/api/auth/admin/")
          : canonicalPath === "/api/auth/admin" || canonicalPath.startsWith("/api/auth/admin/");
      if (isAdminRoute) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      if (req.url?.startsWith("/api/auth")) {
        const declared = declaredContentLength(req);
        if (declared !== null && declared > AUTH_MAX_BODY_BYTES) {
          drainRejectedRequest(req);
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Payload too large");
          return;
        }

        // Better Auth's public Node adapter does not expose its internal
        // `bodySizeLimit` option. Read the request once and replay the bounded
        // bytes through a fresh stream so chunked requests are capped too,
        // without two consumers racing over the same IncomingMessage.
        const limited = await readAuthBody(req, AUTH_MAX_BODY_BYTES);
        if (limited?.exceeded) {
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Payload too large");
          return;
        }

        await deps.authNodeHandler(limited ? requestWithBody(req, limited.body) : req, res);
        return;
      }

      if (req.url?.startsWith("/rpc")) {
        // The one body cap that holds before anything else gets a chance to
        // reject the request: oRPC buffers a multipart body in memory while
        // routing it, which is before auth, rate limiting or any payload check
        // run — an anonymous caller could otherwise make this process buffer
        // arbitrary gigabytes, and the upload budget would never see the
        // request at all.
        //
        // Content-Length is present on every browser multipart upload, which
        // is the traffic this protects. A `Transfer-Encoding: chunked` client
        // has no Content-Length to compare here, so it skips THIS check and is
        // instead sized by the pre-auth gate below, which refuses it on the
        // same terms as an over-the-line declared body.
        const declared = declaredContentLength(req);
        if (declared !== null && declared > RPC_MAX_BODY_BYTES) {
          drainRejectedRequest(req);
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Payload too large");
          return;
        }

        // The pre-auth admission gate. Every `/rpc` procedure is either a small
        // JSON object (a post is 500 characters, an appeal reason 2000, the
        // appeal token 4 KiB — nothing above `RPC_SMALL_BODY_BYTES`) or a file
        // upload — and every upload procedure is session-gated. So a declared
        // body above that line is an upload by definition, and an anonymous
        // caller has no legitimate use for one; refusing it before oRPC parses
        // it is what stops an unauthenticated upload-sized body from ever being
        // buffered, instead of buffering it and then rejecting it as
        // UNAUTHORIZED. The one exception is the public appeal surface, which
        // is small by construction: an oversized appeal body is refused on its
        // own low limit rather than being handed to the session demand.
        //
        // Chunked (`Transfer-Encoding`) bodies carry no Content-Length, so no
        // declared-length check can see them at all — which is why they get
        // the same treatment as a body already known to be over the line,
        // rather than skipping the gate entirely: the session demand applies
        // to them exactly as it does to an oversized upload, so an anonymous
        // caller cannot trade a missing header for a buffer. The appeal path
        // cannot demand a session (it is the one public surface), and every
        // client that legitimately reaches it — a browser following the email
        // link — sends a plain JSON body with a Content-Length, so a chunked
        // appeal request is refused with 411 rather than admitted to buffer
        // against nothing. What survives both refusals — an AUTHENTICATED
        // upload-sized or chunked body — is then bounded twice over: per body
        // by oRPC's BodyLimitPlugin at `RPC_MAX_BODY_BYTES`, and in number by
        // the admission cap below.
        const isChunked = isChunkedRequestBody(req);
        const exceedsSmallBodyBound =
          isChunked || (declared !== null && declared > RPC_SMALL_BODY_BYTES);
        if (exceedsSmallBodyBound && canonicalPath === RPC_APPEAL_OPEN_PATH) {
          if (isChunked) {
            // No session to demand and no length to compare, so there is no
            // version of this request the gate can admit: refuse the encoding,
            // not a size. `drainRejectedRequest` first — a chunked stream kept
            // readable lets the refusal finish cleanly on keep-alive too.
            drainRejectedRequest(req);
            res.writeHead(411, { "Content-Type": "text/plain" });
            res.end("Length required");
          } else {
            drainRejectedRequest(req);
            res.writeHead(413, { "Content-Type": "text/plain" });
            res.end("Payload too large");
          }
          return;
        }

        // Whether this dispatch may buffer past the small-body line at all —
        // exactly what the admission cap below bounds in number. Only a
        // non-appeal request over the line gets here, and the session demand
        // above has already narrowed those to authenticated callers; small
        // JSON bodies stay outside the cap entirely.
        let buffersPastSmallLine = false;
        if (exceedsSmallBodyBound) {
          const session = hasSessionCookie(req.headers.cookie)
            ? await deps.resolveSession(req)
            : null;
          if (!session || session.kind !== "authenticated") {
            // Same shape as the media gate: no-store so a cached 401 cannot
            // linger after the caller signs in, and fail-closed on an
            // unavailable session store — without a viewer there is no
            // legitimate upload either.
            drainRejectedRequest(req);
            res.writeHead(401, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
            res.end("Unauthorized");
            return;
          }
          buffersPastSmallLine = true;
        }

        // The admission cap, scoped to the requests whose bodies can actually
        // grow: small JSON dispatches are each bounded by
        // `RPC_SMALL_BODY_BYTES` and by their procedure's rate limit, so
        // counting them here would buy nothing against buffering while making
        // ordinary read traffic answer 503 under modest concurrency. A
        // saturated handler answers 503 rather than joining the queue.
        if (buffersPastSmallLine) {
          if (rpcInFlight >= MAX_RPC_IN_FLIGHT) {
            drainRejectedRequest(req);
            res.writeHead(503, { "Content-Type": "text/plain" });
            res.end("Server busy");
            return;
          }
          rpcInFlight += 1;
        }
        try {
          const { matched } = await deps.handleRpc(req, res);
          if (matched) return;
        } finally {
          if (buffersPastSmallLine) rpcInFlight -= 1;
        }
      }

      if (req.url?.startsWith(MEDIA_PREFIX)) {
        // Reads only. These URLs sit in `<img src>` all over the app, and a
        // write verb reaching object storage through them is not something to
        // leave to the bucket's own permissions to refuse. Checked before the
        // session gate below: a wrong verb is refused regardless of who is
        // asking.
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, HEAD" });
          res.end("Method not allowed");
          return;
        }

        // Same session gate as the page gate below, and deliberately BEFORE
        // the key is even parsed: an anonymous caller must not be able to
        // learn which keys are well-formed, let alone which objects exist, by
        // watching whether the response differs. `no-store` is load-bearing,
        // not decoration — without it a cached 401 could keep showing a
        // broken image after the browser signs in, a failure mode invisible
        // enough to be worth spelling out explicitly rather than relying on a
        // 401 being merely non-heuristically-cacheable by default.
        //
        // This closes the one remaining anonymous read of user content: a
        // media key that leaked (a pasted link, browser history, a log line)
        // used to work forever, for anyone. It still requires a session now,
        // same as every oRPC procedure (issue #36) and every page (the page
        // gate above). What this does NOT do is revoke a presigned URL
        // already handed out — that is a bearer credential good for its own
        // TTL regardless, since this server never sees it again once issued.
        const session = hasSessionCookie(req.headers.cookie)
          ? await deps.resolveSession(req)
          : null;
        if (!session || session.kind === "anonymous") {
          res.writeHead(401, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
          res.end("Unauthorized");
          return;
        }

        const key = mediaKeyOf(req.url);

        // An unavailable session store leaves a cookie but no viewer identity,
        // and every key — post and profile alike — is authorized per viewer by
        // the resolver. There is no anonymous or viewer-less path to an
        // object, so fail closed for all of them: without a viewer there is no
        // one to authorize the request against.
        if (session.kind !== "authenticated") {
          res.writeHead(503, {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store",
          });
          res.end("Service unavailable");
          return;
        }

        const media = key ? await deps.resolveMediaUrl(key, session.userId) : null;

        if (!media) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        // A redirect rather than a proxy: the bytes go straight from the
        // bucket to the browser, which costs no service egress and never holds
        // an image in this process's memory.
        //
        // Every redirect is viewer-authorized, and the decision can change
        // after account switching, blocking, banning, or profile updates — so
        // the DEFAULT is `private, no-store`: a browser must ask this route to
        // authorize the current viewer again rather than reuse a bearer
        // redirect. The resolver may exempt a key class from that (today, only
        // profile display objects), and its directive is already window-bounded
        // to outlive no signature.
        res.writeHead(302, {
          Location: media.url,
          "Cache-Control": media.cacheControl ?? "private, no-store",
        });
        res.end();
        return;
      }

      // The branding host: `about.mytuums.com` is the one hostname this server
      // answers that is not the app. It gets the built branding site
      // (apps/branding, served through `serveBranding`) instead of the SPA —
      // the site needs none of the one-origin guarantees (no /rpc, no
      // /media, absolute CTA links to the apex), while the SPA booted on this
      // host would be stranded: session cookies are host-only to the apex, so
      // it would look signed out, and its canonical and Open Graph tags would
      // lie about their origin. The site's scripts are same-origin module
      // scripts, already covered by the CSP's `script-src 'self'`.
      //
      // Placement is the whole design. AFTER every API prefix, so /health,
      // /api/auth, /rpc and /media keep their normal meaning on every host
      // and this branch shadows nothing the server owns. BEFORE the page
      // gate below, which is itself the bypass: the gate never sees a
      // branding-host document request, so the landing page is public
      // without a single change to SIGNED_OUT_PATHS — adding "/" to that set
      // would open the apex homepage too, and its shared client gate would
      // then bounce a signed-in visitor off it. Anything the handler declines
      // — an asset-shaped path that misses on disk, a non-GET/HEAD verb —
      // keeps falling through the tree exactly as on the apex.
      if (isBrandingHostRequest(req)) {
        const { served } = await deps.serveBranding(req, res);
        if (served) return;
      }

      // The page gate: everything that reaches here is neither `/health`,
      // `/api/auth`, `/rpc` nor `/media` — i.e. it is either a page the SPA
      // would render or a static asset. Placed after those prefixes rather
      // than at the top of the tree, deliberately, so this needs no
      // hand-maintained copy of the routing decisions above it — `/` reaches
      // here exactly as it always did.
      //
      // The site is private: `apps/web/src/hooks/use-require-signed-in.ts`
      // bounces every path outside `SIGNED_OUT_PATHS` to `/login` client-side,
      // but only after the bundle downloads, the splash clears and the first
      // `/get-session` resolves — the app mounting and firing its own queries
      // in between. That round trip is wasted work (and, before this gate,
      // the only thing standing between an anonymous visitor and the shell)
      // that the server can skip for the common case.
      //
      // Only extension-less GET/HEAD requests are gated — the same rule
      // `static-files.ts`'s SPA fallback uses for "this is a client route, not
      // an asset". A gated asset would be a bug with a nasty failure mode:
      // `/login` needs its own JS and CSS to render at all, so gating those
      // would turn the redirect into a blank page.
      //
      // `path.extname` is checked against the PATHNAME, never the raw
      // `req.url` — a query string can itself contain a dot (`?ref=site.com`,
      // a decimal in a numeric param), and `path.extname` has no idea where a
      // path ends and a query begins. Checking the raw url would let a
      // crafted query string masquerade a real page as an asset and skip the
      // gate entirely.
      if (req.method === "GET" || req.method === "HEAD") {
        const pathname = pageGatePathname(req.url ?? "");

        if (pathname !== null && path.extname(pathname) === "" && !SIGNED_OUT_PATHS.has(pathname)) {
          // No cookie at all is the cheap, common case: redirect without
          // paying for a session lookup. A cookie that turns out to be stale
          // or forged still needs the real check below — that is the whole
          // reason this gate validates a session rather than only checking
          // for a cookie the way the old `/`-only version did.
          const hasCookie = hasSessionCookie(req.headers.cookie);
          const hasSession = hasCookie && (await deps.resolveSession(req)).kind !== "anonymous";

          if (!hasSession) {
            const search = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
            const redirect = encodeURIComponent(pathname + search);
            res.writeHead(302, { Location: `/login?redirect=${redirect}` });
            res.end();
            return;
          }
        }
      }

      // After every API prefix, so a route this server owns can never be
      // shadowed by a file that happens to share its name.
      const { served } = await deps.serveStatic(req, res);
      if (served) return;

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (error) {
      // The error observer receives the pathname only, never the raw URL:
      // query strings are where appeal and password-reset tokens ride.
      deps.observeError({
        source: "request",
        error: normalizeObservedError(error),
        requestId,
        method: req.method ?? "?",
        path: pathnameOf(req.url) ?? "?",
      });

      if (res.headersSent) {
        // Response already started; we cannot send a fresh status/body.
        // Destroy the socket rather than risk a second, malformed write.
        res.destroy();
        return;
      }

      // The requestId rides the error body so a user (or their support
      // ticket) can cite the exact request that failed — it is a random
      // UUID, revealing nothing about the system.
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error", requestId }));
    }
  };
}
