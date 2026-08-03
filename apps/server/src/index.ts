import { parseEnv } from "./env.js";
import { resolveClientIp } from "./client-ip.js";
import { createRequestHandler } from "./request-handler.js";
import { createStaticFileHandler, noStaticFiles } from "./static-files.js";
import { createServer } from "node:http";
import { RPCHandler } from "@orpc/server/node";
import { CORSPlugin } from "@orpc/server/plugins";
import { onError } from "@orpc/server";
import { appRouter, createContext, createMediaResolver, defaultStorage } from "@my-tuums/api";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { auth } from "@my-tuums/auth";
import { closeDb, pingDb } from "@my-tuums/db";

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

const authNodeHandler = toNodeHandler(auth);

const handler = new RPCHandler(appRouter, {
  plugins: [
    new CORSPlugin({
      origin: [env.WEB_ORIGIN],
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    }),
  ],
  interceptors: [
    onError((error) => {
      console.error("oRPC error:", error);
    }),
  ],
});

// The routing decision tree itself lives in request-handler.ts, unit-tested
// there against stand-ins for these four dependencies. This is the only
// place they become real: a live DB ping, BetterAuth's actual node handler,
// a real oRPC context resolved per request, and a real presigner over the
// configured bucket (or one that always 404s, when no bucket is configured).
const handleRequest = createRequestHandler({
  pingDb,
  authNodeHandler,
  handleRpc: async (req, res) => {
    const context = await createContext({
      headers: fromNodeHeaders(req.headers),
      clientIp: resolveClientIp(req, env.TRUST_PROXY),
    });

    return handler.handle(req, res, { prefix: "/rpc", context });
  },
  resolveMediaUrl: createMediaResolver(defaultStorage),
  // Only when this deployment bundles the built web app. Unset in dev, where
  // Vite serves it and proxies /rpc, /api/auth and /media back here — see
  // ./static-files.ts for why one origin is a requirement rather than a
  // preference.
  serveStatic: env.WEB_DIST ? createStaticFileHandler(env.WEB_DIST) : noStaticFiles,
});

// `createServer`'s callback type is `(req, res) => void`; passing an async
// function directly is exactly the "misused promise" shape Step 3's crash
// fix was about (`@typescript-eslint/no-misused-promises` now flags it).
// Keep the listener itself synchronous and explicitly `void` the async
// work — `handleRequest`'s own try/catch still converts every failure into a
// response, and the `unhandledRejection` handler further down is the
// backstop if something ever escapes it anyway.
const server = createServer((req, res) => {
  void handleRequest(req, res);
});

/**
 * Drains the Postgres pool and force-exits. Split out from `shutdown` so it
 * can be invoked from a plain (non-async) `server.close` callback via
 * `void drainAndExit(...)` — passing an async function directly as the
 * callback would hand `net.Server` a Promise it doesn't await, which is
 * exactly the floating/misused-promise bug class Step 3 fixed.
 */
async function drainAndExit(code: number, forceExitTimer: NodeJS.Timeout) {
  try {
    await closeDb();
    console.error("Database pool drained.");
  } catch (error) {
    console.error("Error draining database pool:", error);
  } finally {
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
  shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
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
