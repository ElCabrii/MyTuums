import { parseEnv } from "./env.js";
import { createRequestHandler, type RequestResponse } from "./request-handler.js";
import { createStaticFileHandler, noStaticFiles } from "./static-files.js";
import { decorateResponse } from "./response-decorators.js";
import { createServer } from "node:http";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/node";
import { CORSPlugin, SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { ORPCError, onError } from "@orpc/server";
import { appRouter, createContext, createMediaResolver, defaultStorage } from "@my-tuums/api";
import { RPC_MAX_BODY_BYTES } from "@my-tuums/api/constants";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { auth } from "@my-tuums/auth";
import { closeDb, pingDb } from "@my-tuums/db";
import { createErrorObserver, normalizeObservedError } from "./error-observation.js";
import { attachAccessLog, responseHeaderText } from "./observability.js";
import { flushSentry, initSentry, reportError } from "./sentry.js";

// The one place `parseEnv`'s throw becomes `process.exit(1)`. Importing
// `./env.js` elsewhere — a future test, a script — can now inspect or expect
// that throw without also killing whatever imported it; only this, the real
// entrypoint, treats "invalid environment" as fatal.
let env;
try {
  env = parseEnv(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const PORT = env.PORT;

// Sentry is wired only when a DSN exists — the unset state (dev, CI) keeps
// the no-op client, so every `reportError`/`flushSentry` call below is safe
// unconditionally. The SDK's own uncaught/unhandled handlers are dropped in
// `initSentry`: this file owns those two process events and reports them
// itself (see the handlers below), then flushes before exit.
if (env.SENTRY_DSN) {
  initSentry(env.SENTRY_DSN, env.NODE_ENV);
}

const observeError = createErrorObserver({
  report: reportError,
  log: (message, error) => console.error(message, error),
});

const authNodeHandler = toNodeHandler(auth);

function nodeResponse(response: RequestResponse): import("node:http").ServerResponse {
  // SAFETY: Production invokes the routing tree only from node:http's createServer callback.
  return response as import("node:http").ServerResponse;
}

const handler = new RPCHandler(appRouter, {
  plugins: [
    new CORSPlugin({
      origin: [env.WEB_ORIGIN],
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    }),
    // CORS stops an attacker from READING a response, but `multipart/form-data`
    // — the upload procedures' content type — is one of the three that skip
    // preflight, so a cross-origin `<form>` could still POST with the session
    // cookie attached. What had been quietly protecting us is BetterAuth's
    // `SameSite=Lax` cookie default; this makes the defence something the code
    // states rather than something it inherits. The oRPC client sends the
    // header it requires; an HTML form cannot.
    new SimpleCsrfProtectionHandlerPlugin(),
    // The router's own cap (request-handler.ts) reads Content-Length, which a
    // chunked (Transfer-Encoding) body does not carry — legitimate Node http
    // clients send chunked whenever they omit Content-Length, so rejecting
    // chunked outright would cut them off. This plugin counts body bytes as
    // they stream and rejects at the same ceiling, before oRPC finishes
    // buffering: one cap, two enforcement points for the two framings.
    new BodyLimitPlugin({ maxBodySize: RPC_MAX_BODY_BYTES }),
  ],
  interceptors: [
    onError((error, { context }) => {
      observeError({
        source: "orpc",
        error: normalizeObservedError(error),
        requestId: context.requestId,
        // Unknown errors become INTERNAL_SERVER_ERROR inside oRPC; this
        // interceptor is the only place they surface before that mapping.
        status: error instanceof ORPCError ? error.status : 500,
      });
    }),
  ],
});

// The routing decision tree itself lives in request-handler.ts, unit-tested
// there against stand-ins for these six dependencies. This is the only
// place they become real: a live DB ping, BetterAuth's actual node handler,
// a real oRPC context resolved per request, a real presigner over the
// configured bucket (or one that always 404s, when no bucket is configured),
// and a real session check for the page gate.
const handleRequest = createRequestHandler({
  pingDb,
  authNodeHandler: (req, res) => authNodeHandler(req, nodeResponse(res)),
  handleRpc: async (req, res) => {
    const context = await createContext({
      headers: fromNodeHeaders(req.headers),
      // The routing tree set this before dispatching here (request-handler.ts
      // generates the id at the top of every request), so the header is the
      // handoff: the same id the access log and the response carry becomes
      // the Context's, and from there the oRPC error interceptor's Sentry
      // tag. The dash fallback mirrors observability.ts's — unreachable in
      // production, harmless if a future caller skips the routing tree.
      requestId: responseHeaderText(res.getHeader("x-request-id")),
    });

    return handler.handle(req, nodeResponse(res), { prefix: "/rpc", context });
  },
  resolveMediaUrl: createMediaResolver(defaultStorage),
  // Only when this deployment bundles the built web app. Unset in dev, where
  // Vite serves it and proxies /rpc, /api/auth and /media back here — see
  // ./static-files.ts for why one origin is a requirement rather than a
  // preference.
  serveStatic: async (req, res) => {
    const staticHandler = env.WEB_DIST ? createStaticFileHandler(env.WEB_DIST) : noStaticFiles;
    return staticHandler(req, nodeResponse(res));
  },
  // Deliberately fails OPEN (`true`) on any error — a database blip must
  // degrade to "the client gate decides", the behaviour every visitor already
  // had before this server-side gate existed, never to "every signed-in
  // visitor gets bounced to /login and reads it as a mass logout". The page
  // gate leaks nothing on a false positive: the served shell carries no data
  // (see request-handler.ts), and every `/rpc` procedure still requires its
  // own session independently.
  hasValidSession: async (req) => {
    try {
      return (await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })) !== null;
    } catch (error) {
      console.error(
        "Page gate: session check failed; serving the app and letting its own gate decide:",
        error,
      );
      return true;
    }
  },
  observeError,
});

// `createServer`'s callback type is `(req, res) => void`; passing an async
// function directly is exactly the "misused promise" shape the enforced
// `@typescript-eslint/no-misused-promises` rule exists to flag.
// Keep the listener itself synchronous and explicitly `void` the async
// work — `handleRequest`'s own try/catch still converts every failure into a
// response, and the `unhandledRejection` handler further down is the
// backstop if something ever escapes it anyway.
// `decorateResponse` is the one place every response — health, auth, rpc,
// media, static, 404 — gets its security headers and, when the content is
// JSON and the body is big enough, gzip/brotli compression (see
// ./response-decorators.ts). It wraps the `res` before any handler sees it,
// so nothing below has to know it exists; handlers that set a header
// themselves keep their value (inner wins).
// `attachAccessLog` (./observability.ts) hooks the same `res` for its
// finish listener: one JSON access-log line per completed request, carrying
// the requestId the routing tree generated. It composes with the decorator
// because both wrap the same object and each only adds what it owns.
const server = createServer((req, res) => {
  void handleRequest(req, attachAccessLog(req, decorateResponse(req, res)));
});

/**
 * Drains the Postgres pool and force-exits. Split out from `shutdown` so it
 * can be invoked from a plain (non-async) `server.close` callback via
 * `void drainAndExit(...)` — passing an async function directly as the
 * callback would hand `net.Server` a Promise it doesn't await, which is
 * exactly the floating/misused-promise bug class the enforced lint rules are
 * meant to catch.
 */
async function drainAndExit(code: number, forceExitTimer: NodeJS.Timeout) {
  try {
    await closeDb();
    console.error("Database pool drained.");
  } catch (error) {
    console.error("Error draining database pool:", error);
  } finally {
    // The very events this shutdown may be reporting must not die with the
    // process: flush drains Sentry's queue before exit (best effort, 2s
    // cap — a hung network must not delay a deliberate shutdown forever).
    // Without a Sentry client this resolves immediately. A false result
    // means events were still queued when the cap ran out — logged, never
    // fatal: the alternative (waiting forever) is worse than the dropped
    // events. A rejecting flush must not skip the exit either — the
    // force-exit timer below is the backstop for a hung drain, not for a
    // thrown one.
    let flushed = true;
    try {
      flushed = await flushSentry(2000);
    } catch (error) {
      console.error("Sentry flush failed:", error);
    }
    if (!flushed) console.error("Sentry queue not fully drained before exit.");
    clearTimeout(forceExitTimer);
    process.exit(code);
  }
}

/**
 * Deliberate, logged shutdown: stop accepting new connections, let in-flight
 * requests finish, drain the Postgres pool, then exit with `code`. Used both
 * for conditions we can no longer trust the process to keep running under
 * (unhandled rejections, uncaught exceptions) and for orchestrator-initiated
 * shutdown (SIGTERM/SIGINT). A force-exit timeout guards against a close or
 * drain that never resolves (e.g. a socket or query stuck open).
 */
function shutdown(reason: string, code: number) {
  console.error(`Shutting down: ${reason}`);

  const forceExitTimer = setTimeout(() => {
    console.error("Shutdown timed out; forcing exit.");
    process.exit(code);
  }, 5000);
  forceExitTimer.unref();

  server.close((closeError) => {
    if (closeError) {
      console.error("Error while closing HTTP server:", closeError);
    } else {
      console.error("HTTP server closed; no longer accepting new connections.");
    }

    void drainAndExit(code, forceExitTimer);
  });
}

process.on("unhandledRejection", (reason) => {
  const decision = observeError({
    source: "process",
    event: "unhandledRejection",
    error: normalizeObservedError(reason),
  });
  if (decision.action === "shutdown") shutdown(decision.reason, decision.exitCode);
});

process.on("uncaughtException", (error) => {
  const decision = observeError({ source: "process", event: "uncaughtException", error });
  if (decision.action === "shutdown") shutdown(decision.reason, decision.exitCode);
});

// Orchestrators (Docker, k8s, `docker compose stop`) send SIGTERM; Ctrl+C
// sends SIGINT. Both should drain deliberately rather than sever in-flight
// requests and leave Postgres connections dangling. Exit code 0: this is an
// expected, requested shutdown, not a failure.
process.on("SIGTERM", () => {
  shutdown("SIGTERM", 0);
});

process.on("SIGINT", () => {
  shutdown("SIGINT", 0);
});

server.listen(PORT, env.HOST, () => {
  console.log(`🚀 MyTuums Server running on http://${env.HOST}:${PORT}`);
});
