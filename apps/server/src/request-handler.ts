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
