import type { IncomingMessage, ServerResponse } from "node:http";
import { RPC_MAX_BODY_BYTES } from "@my-tuums/api/constants";

/**
 * The stand-ins `createRequestHandler` routes through, injected so the
 * routing tree can be unit-tested with none of them real.
 */
export interface RequestHandlerDeps {
  /** `SELECT 1` — throws if Postgres is unreachable. */
  pingDb: () => Promise<unknown>;
  /** BetterAuth's node handler for everything under `/api/auth`. */
  authNodeHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  /**
   * Resolves the oRPC context and dispatches to the router for everything
   * under `/rpc`. Bundled as one callback — rather than passed apart as
   * `createContext` + `handler.handle` — so this module doesn't need to know
   * about sessions, client IPs, or oRPC at all; it only needs to know whether
   * a `/rpc`-prefixed request was matched.
   */
  handleRpc: (req: IncomingMessage, res: ServerResponse) => Promise<{ matched: boolean }>;
  /**
   * Turns a `/media/<key>` object key into a redirect target and the cache
   * budget for that redirect, or `null` when it should 404.
   *
   * Injected rather than imported for the same reason the three above are:
   * this module's job is the routing decision, and a unit test of it should
   * not need object storage, credentials or a network. The real implementation
   * is `createMediaResolver` in `@my-tuums/api`.
   */
  resolveMediaUrl: (
    key: string,
  ) => Promise<{ url: string; cacheSeconds: number } | null>;
  /**
   * Serves the built web app, when this deployment bundles it.
   *
   * Last in the chain and injected like the rest: in dev it is `noStaticFiles`
   * (Vite serves the app and proxies here), and in production it is a handler
   * over `WEB_DIST`. Reporting `{ served: false }` rather than writing a 404
   * itself keeps the 404 in one place.
   */
  serveStatic: (req: IncomingMessage, res: ServerResponse) => Promise<{ served: boolean }>;
}

const MEDIA_PREFIX = "/media/";

/**
 * The session cookie BetterAuth sets. Hardcoded rather than imported from
 * `@my-tuums/auth` — this module is deliberately free of that dependency (its
 * unit tests stand in for the auth handler) — and packages/auth never
 * overrides the default name. If the upstream default ever changes, the worst
 * case is that the redirect below stops firing: the app's own
 * `useRequireSignedIn` gate still covers the same ground client-side, so this
 * is an optimization with a safe failure mode, not a security control.
 *
 * The name carries a `__Secure-` prefix whenever BetterAuth serves over
 * HTTPS, i.e. every production request; plain HTTP (dev, localhost) gets the
 * bare name. The check below mirrors BetterAuth's own `getCookie` fallback
 * (`parsedCookie.get(`__Secure-${name}`) ?? parsedCookie.get(name)`) so a
 * live cookie in either shape is recognised — a mismatch here 302s *every*
 * visitor at `/` to `/login?redirect=%2F`, logged in or not, and the login
 * page then bounces the real session back to `/` (the reload flicker this
 * recognition exists to prevent).
 */
const SESSION_COOKIE_NAME = "better-auth.session_token";

function hasSessionCookie(cookieHeader: string | undefined): boolean {
  return (
    cookieHeader
      ?.split(";")
      .some((part) => {
        const name = part.trim();
        return (
          name.startsWith(`${SESSION_COOKIE_NAME}=`) ||
          name.startsWith(`__Secure-${SESSION_COOKIE_NAME}=`)
        );
      }) ?? false
  );
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
 * Builds the routing decision tree `index.ts` hands to `createServer`: health
 * check, the `/api/auth` and `/rpc` prefixes, the 404 fallback, and the
 * top-level exception safety net.
 *
 * Pulled out from `index.ts` specifically so this tree — which is entirely
 * our own logic, not a third-party library's — can be unit tested with
 * stand-ins for the five dependencies it routes through, none of which need
 * to be real: no Postgres, no BetterAuth, no oRPC router, no listening
 * socket. What is NOT covered here is CORS — that is `CORSPlugin`'s behaviour
 * on the real `RPCHandler`, which is wire-level HTTP behaviour of a
 * third-party plugin, not a decision this module makes. It stays covered by
 * the Playwright `api` project instead, which is the layer actually
 * positioned to observe response headers over a real connection.
 */
export function createRequestHandler(deps: RequestHandlerDeps) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
          console.error("Health check failed: database unreachable:", error);
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", reason: "database unreachable" }));
        }
        return;
      }

      // A visitor with no session cookie at all is signed out, and a signed-out
      // visitor to `/` is about to be redirected to `/login` by
      // `useRequireSignedIn` — but only after the bundle downloads, the splash
      // clears and the first `/get-session` resolves, with the home page
      // mounting and firing its feed query in between. That whole round trip is
      // wasted work the server can skip, and the redirect target is identical
      // (`?redirect=%2F` included). A visitor whose cookie is present but stale
      // falls through to the app, whose own gate makes the same decision it
      // always has — so this only ever removes work, never changes what a
      // signed-out visitor ends up seeing.
      if (req.url === "/" && req.method === "GET" && !hasSessionCookie(req.headers.cookie)) {
        res.writeHead(302, { Location: "/login?redirect=%2F" });
        res.end();
        return;
      }

      if (req.url?.startsWith("/api/auth")) {
        await deps.authNodeHandler(req, res);
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
        // Content-Length to check, so it is rejected outright rather than
        // buffered. A request carrying both is already refused by Node's own
        // parser before this handler runs.
        if (req.headers["transfer-encoding"]) {
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Payload too large");
          return;
        }

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
        // leave to the bucket's own permissions to refuse.
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, HEAD" });
          res.end("Method not allowed");
          return;
        }

        const key = mediaKeyOf(req.url);
        const media = key ? await deps.resolveMediaUrl(key) : null;

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

      // After every API prefix, so a route this server owns can never be
      // shadowed by a file that happens to share its name.
      const { served } = await deps.serveStatic(req, res);
      if (served) return;

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (error) {
      console.error(`Unhandled error while handling ${req.method ?? "?"} ${req.url ?? "?"}:`, error);

      if (res.headersSent) {
        // Response already started; we cannot send a fresh status/body.
        // Destroy the socket rather than risk a second, malformed write.
        res.destroy();
        return;
      }

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  };
}
