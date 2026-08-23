import {
  IncomingMessage,
  type IncomingHttpHeaders,
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
} from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { RPC_MAX_BODY_BYTES, SIGNED_OUT_PATHS } from "@my-tuums/api/constants";
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
   * Turns a `/media/<key>` object key into a redirect target and the cache
   * budget for that redirect, or `null` when it should 404. Only ever called
   * for a request that already passed the session gate below — this resolver
   * itself has no opinion on who is asking, same as it always has.
   *
   * Injected rather than imported for the same reason the three above are:
   * this module's job is the routing decision, and a unit test of it should
   * not need object storage, credentials or a network. The real implementation
   * is `createMediaResolver` in `@my-tuums/api`.
   */
  resolveMediaUrl: (
    key: string,
    viewerId?: string,
  ) => Promise<{ url: string; cacheSeconds: number } | null>;
  /** Resolves the authenticated media viewer for post-level authorization. */
  getSessionUserId?: (req: IncomingMessage) => Promise<string | null>;
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
   * Whether `req` carries a live session — a real `auth.api.getSession` check,
   * not just "a cookie is present" (see `hasSessionCookie` below, which both
   * gates that use this — the page gate and the `/media` gate — check first
   * to avoid paying for this on every anonymous request).
   *
   * Injected rather than imported for the same reason as the deps above: this
   * module stays free of `@my-tuums/auth`, so its unit tests need no database
   * and no real session store. The real implementation must fail OPEN (return
   * `true`) on an error — see its doc comment in `index.ts` — so a database
   * blip degrades to "the client gate decides" for pages, and "images keep
   * loading" for media, rather than either one turning a database hiccup into
   * a mass sign-out or every avatar in the app breaking at once.
   */
  hasValidSession: (req: IncomingMessage) => Promise<boolean>;
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
 * `mediaKeyOf` above). `SIGNED_OUT_PATHS` is compared against the raw
 * pathname, so an encoded path like `/%6Cogin` — which decodes to `/login`
 * but is not the literal string `"/login"` — fails the allowlist match and
 * gets redirected rather than let through. Failing closed is the right
 * direction for a gate; the worst case is an odd path getting redirected to
 * `/login` unnecessarily, never a signed-out visitor reaching a page they
 * shouldn't.
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
      if (req.url?.startsWith("/api/auth/admin/")) {
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
        // Content-Length is present on every browser multipart upload, which is
        // the traffic this protects; a `Transfer-Encoding: chunked` client has no
        // Content-Length to check, and is legitimately used by Node http clients
        // that omit the header — so chunked bodies are bounded downstream by
        // oRPC's BodyLimitPlugin at the same ceiling (see index.ts).
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > RPC_MAX_BODY_BYTES) {
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Payload too large");
          return;
        }

        const { matched } = await deps.handleRpc(req, res);
        if (matched) return;
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
        const hasSession =
          hasSessionCookie(req.headers.cookie) && (await deps.hasValidSession(req));
        if (!hasSession) {
          res.writeHead(401, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
          res.end("Unauthorized");
          return;
        }

        const key = mediaKeyOf(req.url);
        const viewerId = deps.getSessionUserId
          ? ((await deps.getSessionUserId(req)) ?? undefined)
          : undefined;
        const media = key
          ? viewerId === undefined
            ? await deps.resolveMediaUrl(key)
            : await deps.resolveMediaUrl(key, viewerId)
          : null;

        if (!media) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        // A redirect rather than a proxy: the bytes go straight from the
        // bucket to the browser, which costs no service egress and never holds
        // an image in this process's memory.
        //
        // The cache is private and bounded by the signing window. Private
        // because the URL it points at is a bearer credential — a shared cache
        // handing it to another viewer would be handing out access. Bounded
        // because the URL is byte-identical only until the window rolls (see
        // MEDIA_SIGNING_WINDOW_MS); the resolver reports the remaining budget
        // so this never serves a stale signature.
        res.writeHead(302, {
          Location: media.url,
          "Cache-Control": `private, max-age=${media.cacheSeconds}`,
        });
        res.end();
        return;
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
          const hasSession = hasCookie && (await deps.hasValidSession(req));

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
