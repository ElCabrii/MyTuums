import { createServer } from "node:http";
import { RPCHandler } from "@orpc/server/node";
import { CORSPlugin } from "@orpc/server/plugins";
import { onError } from "@orpc/server";
import { appRouter } from "@my-tuums/api";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";

const PORT = Number(process.env.PORT) || 3001;

const authNodeHandler = toNodeHandler(auth);

const handler = new RPCHandler(appRouter, {
  plugins: [new CORSPlugin()],
  interceptors: [
    onError((error) => {
      console.error("oRPC error:", error);
    }),
  ],
});

const server = createServer(async (req, res) => {
  // Set CORS headers for better-auth API requests
  const origin = req.headers.origin;
  if (origin && (origin === "http://localhost:5173" || origin === "http://localhost:3000")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  }

  if (req.method === "OPTIONS" && req.url?.startsWith("/api/auth")) {
    res.writeHead(204);
    res.end();
    return;
  }

  // Handle BetterAuth endpoints
  if (req.url?.startsWith("/api/auth")) {
    return authNodeHandler(req, res);
  }

  const { matched } = await handler.handle(req, res, {
    prefix: "/rpc",
    context: {},
  });

  if (matched) return;

  // Health endpoint outside oRPC
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 MyTuums Server running on http://localhost:${PORT}`);
});
