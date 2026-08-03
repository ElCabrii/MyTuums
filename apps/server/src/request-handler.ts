import type { IncomingMessage, ServerResponse } from "node:http";

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
   * Turns a `/media/<key>` object key into a URL to redirect the browser to,
   * or `null` when it should 404.
   *
   * Injected rather than imported for the same reason the three above are:
   * this module's job is the routing decision, and a unit test of it should
   * not need object storage, credentials or a network. The real implementation
   * is `createMediaResolver` in `@my-tuums/api`.
   */
  resolveMediaUrl: (key: string) => Promise<string | null>;
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
 * The routing decision tree `index.ts` hands to `createServer`: health check,
 * the `/api/auth` and `/rpc` prefixes, the 404 fallback, and the top-level
 * exception safety net.
 *
 * Pulled out from `index.ts` specifically so this tree — which is entirely
 * our own logic, not a third-party library's — can be unit tested with
 * stand-ins for the three things it actually depends on, none of which need
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

      if (req.url?.startsWith("/api/auth")) {
        await deps.authNodeHandler(req, res);
        return;
      }

      if (req.url?.startsWith("/rpc")) {
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
        const url = key ? await deps.resolveMediaUrl(key) : null;

        if (!url) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        // A redirect rather than a proxy: the bytes go straight from the
        // bucket to the browser, which costs no service egress and never holds
        // an image in this process's memory.
        //
        // The cache is private and short. Private because the URL it points at
        // is a bearer credential — a shared cache handing it to another viewer
        // would be handing out access. Short because that URL expires, and the
        // redirect must not outlive it (see MEDIA_URL_TTL_SECONDS).
        res.writeHead(302, {
          Location: url,
          "Cache-Control": "private, max-age=300",
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
