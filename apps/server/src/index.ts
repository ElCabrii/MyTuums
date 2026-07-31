import { env } from "./env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { RPCHandler } from "@orpc/server/node";
import { CORSPlugin } from "@orpc/server/plugins";
import { onError } from "@orpc/server";
import { appRouter, createContext } from "@my-tuums/api";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { auth } from "@my-tuums/auth";
import { closeDb, pingDb } from "@my-tuums/db";

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

// `createServer`'s callback type is `(req, res) => void`; passing an async
// function directly is exactly the "misused promise" shape Step 3's crash
// fix was about (`@typescript-eslint/no-misused-promises` now flags it).
// Keep the listener itself synchronous and explicitly `void` the async
// work — the try/catch below still converts every failure into a response,
// and the `unhandledRejection` handler further down is the backstop if
// something ever escapes it anyway.
const server = createServer((req, res) => {
  void handleRequest(req, res);
});

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    // Health endpoint checked first, above /rpc and /api/auth, so probes
    // don't pay for oRPC route matching or a session lookup. It actually
    // exercises the DB connection (SELECT 1) rather than returning a
    // hardcoded 200 — a probe that's green while Postgres is down is worse
    // than no probe at all.
    if (req.url === "/health") {
      try {
        await pingDb();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      } catch (error) {
        console.error("Health check failed: database unreachable:", error);
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", reason: "database unreachable" }));
      }
      return;
    }

    // Handle BetterAuth endpoints
    if (req.url?.startsWith("/api/auth")) {
      return await authNodeHandler(req, res);
    }

    if (req.url?.startsWith("/rpc")) {
      const context = await createContext({ headers: fromNodeHeaders(req.headers) });

      const { matched } = await handler.handle(req, res, {
        prefix: "/rpc",
        context,
      });

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
}

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
