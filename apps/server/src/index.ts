import { parseEnv } from "./env.js";
import { createRequestHandler } from "./request-handler.js";
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
import { attachAccessLog } from "./observability.js";
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

const authNodeHandler = toNodeHandler(auth);

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
      try {
        // The requestId makes the line grep-able back to the x-request-id of
        // the response the client actually saw.
        console.error(`[${context.requestId}] oRPC error:`, error);

        // Only 500-class faults (and unknown errors, which oRPC maps to
        // INTERNAL_SERVER_ERROR) belong in Sentry: a 4xx is the caller's
        // mistake — validation, not-found, unauthorized — expected by the
        // client and handled there. An unknown thrown error, though, is a
        // crash inside a procedure, and this interceptor is the only place
        // it surfaces (oRPC catches it before it can reach the routing
        // tree's safety net).
        const status = error instanceof ORPCError ? error.status : 500;
        if (status >= 500) reportError(error, context.requestId);
      } catch (reportFailure) {
        // A throwing reporter must not replace the original procedure error
        // the client is about to receive — the interceptor re-throws what
        // this callback lets escape, so an unguarded throw here would send
        // the client the reporter's error instead of the real one.
        console.error(`[${context.requestId}] Error reporter threw:`, reportFailure);
      }
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
  authNodeHandler,
  handleRpc: async (req, res) => {
    const context = await createContext({
      headers: fromNodeHeaders(req.headers),
      // The routing tree set this before dispatching here (request-handler.ts
      // generates the id at the top of every request), so the header is the
      // handoff: the same id the access log and the response carry becomes
      // the Context's, and from there the oRPC error interceptor's Sentry
      // tag. The dash fallback mirrors observability.ts's — unreachable in
      // production, harmless if a future caller skips the routing tree.
      requestId: (res.getHeader("x-request-id") as string | undefined) ?? "-",
    });

    return handler.handle(req, res, { prefix: "/rpc", context });
  },
  resolveMediaUrl: createMediaResolver(defaultStorage),
  // Only when this deployment bundles the built web app. Unset in dev, where
  // Vite serves it and proxies /rpc, /api/auth and /media back here — see
  // ./static-files.ts for why one origin is a requirement rather than a
  // preference.
  serveStatic: env.WEB_DIST ? createStaticFileHandler(env.WEB_DIST) : noStaticFiles,
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
  // The safety net's crash notification leaves the routing tree through
  // this callback — Sentry, with the requestId the tree generated attached.
  // The routing tree itself keeps doing its own console.error; this is
  // the report to the aggregator, not a replacement for the log.
  onUnhandledError: (error, requestId) => {
    // A client that hangs up mid-response is expected traffic on a public
    // app, not a server fault — and unlike the oRPC interceptor's 500-class
    // filter, this path never sees the status: the rejection escapes the
    // handler and lands here unfiltered. Skip those, so the "only 500-class
    // faults reach Sentry" invariant holds here too. ECONNRESET/EPIPE are
    // the client-abort codes; ERR_STREAM_DESTROYED is the same class of
    // write failure (the socket gone before the response finished) wearing
    // a different name.
    //
    // The tradeoff, accepted: a database fault that surfaces AS a socket
    // error (e.g. postgres.js rejecting with the underlying ECONNRESET)
    // is skipped too. It is still console-logged and access-logged with
    // its 500, so the event is recoverable — this filter only decides
    // what reaches the aggregator, and a heuristic that silences the
    // common expected noise is worth missing the rare misattributed
    // fault.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ECONNRESET" ||
        error.code === "EPIPE" ||
        error.code === "ERR_STREAM_DESTROYED")
    ) {
      return;
    }
    reportError(error, requestId);
  },
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
  console.error("Unhandled promise rejection:", reason);
  // Process-level faults have no request to belong to — the event goes to
  // Sentry with no requestId tag, and the flush inside `shutdown` carries
  // it out before the exit. A throwing reporter must not crash the process
  // a second time with the wrong error, or skip the graceful shutdown.
  try {
    reportError(reason);
  } catch (error) {
    console.error("Failed to report to Sentry:", error);
  }
  shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  try {
    reportError(error);
  } catch (reportFailure) {
    console.error("Failed to report to Sentry:", reportFailure);
  }
  shutdown("uncaughtException", 1);
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
