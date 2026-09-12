import { expect, it } from "vitest";
import {
  RPC_MAX_BODY_BYTES,
  RPC_SMALL_BODY_BYTES,
  SIGNED_OUT_PATHS,
} from "@my-tuums/api/constants";
import {
  createWorkerRequestHandler,
  WORKER_AUTH_MAX_BODY_BYTES,
  type WorkerRequestDependencies,
} from "./worker-request-handler.js";
import { workerResponseHeaders } from "./worker-response-headers.js";

const origin = "https://cf-poc.example.com";
const accessHeaders = {
  "cf-access-jwt-assertion": "synthetic-access",
  "cf-connecting-ip": "192.0.2.8",
};
function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(accessHeaders);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return new Request(new URL(path, origin), { ...init, headers });
}

async function fixture(overrides: Partial<WorkerRequestDependencies> = {}) {
  const deps: WorkerRequestDependencies = {
    origin,
    authorizeAccess: (request) =>
      Promise.resolve(request.headers.get("cf-access-jwt-assertion") === "synthetic-access"),
    pingDb: () => Promise.resolve(),
    resolveSession: () => Promise.resolve({ kind: "authenticated", userId: "viewer" }),
    async handleAuth(request) {
      return Response.json({ route: "auth", body: await request.text() });
    },
    async handleRpc(request, requestId) {
      return Response.json({
        route: "rpc",
        requestId,
        body: await request.text(),
        ip: request.headers.get("x-mytuums-client-ip"),
      });
    },
    resolveMedia: (key, viewer) => Promise.resolve(new Response(`${key}:${viewer}`)),
    fetchAsset(request) {
      const path = new URL(request.url).pathname;
      if (path === "/index.html")
        return Promise.resolve(
          new Response("<html><title>App</title></html>", {
            headers: { "content-type": "text/html" },
          }),
        );
      if (path === "/assets/ok.js")
        return Promise.resolve(
          new Response("export {};", {
            headers: { "cache-control": "public, max-age=31536000, immutable" },
          }),
        );
      return Promise.resolve(new Response("Not found", { status: 404 }));
    },
    async transformDocument(response) {
      return new Response((await response.text()).replace("App", "Public metadata"), {
        headers: response.headers,
      });
    },
    responseHeaders: await workerResponseHeaders({
      streamOrigins: ["https://customer-test.cloudflarestream.com"],
    }),
    observe() {},
    ...overrides,
  };
  return createWorkerRequestHandler(deps);
}

it("requires Access and the configured origin before every route, including health and assets", async () => {
  const handle = await fixture();
  for (const path of [
    "/live",
    "/health",
    "/api/auth/get-session",
    "/rpc/post/list",
    "/media/private.jpg",
    "/assets/ok.js",
    "/login",
  ]) {
    expect(
      (await handle(request(path, { headers: { "cf-access-jwt-assertion": "invalid" } }))).status,
    ).toBe(404);
    expect((await handle(request(`https://alternate.workers.dev${path}`))).status).toBe(404);
  }
});

it("overwrites caller identity with the validated edge address and refuses missing edge identity", async () => {
  const handle = await fixture();
  const response = await handle(
    request("/rpc/post/list", {
      headers: {
        "x-mytuums-client-ip": "198.51.100.2",
        "x-forwarded-for": "198.51.100.3",
      },
    }),
  );
  expect(await response.json()).toMatchObject({
    ip: "192.0.2.8",
    requestId: response.headers.get("x-request-id"),
  });
  expect(
    (await handle(request("/rpc/post/list", { headers: { "cf-connecting-ip": "" } }))).status,
  ).toBe(400);
  expect((await handle(request("/health", { headers: { "cf-connecting-ip": "" } }))).status).toBe(
    200,
  );
});

it("denies every normalized admin spelling before invoking Better Auth", async () => {
  const handle = await fixture();
  for (const path of [
    "/api/auth/admin",
    "/api/auth/admin/ban-user",
    "/api/auth/admin%2Fban-user",
    "/api//auth/%61dmin/ban-user",
    "/api/auth/x%2f..%2fadmin/ban-user",
  ]) {
    expect((await handle(request(path))).status).toBe(404);
  }
  expect((await handle(request("/api/auth/get-session"))).status).toBe(200);
});

it("rejects anonymous upload bodies before dispatch and cancels their stream", async () => {
  const handle = await fixture();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const upload = new Request(`${origin}/rpc/profile/uploadImage`, {
    method: "POST",
    headers: accessHeaders,
    body,
    duplex: "half",
  });
  expect((await handle(upload)).status).toBe(401);
  expect(cancelled).toBe(true);
});

it("caps declared and actual RPC bytes, including a falsely small Content-Length", async () => {
  const handle = await fixture();
  expect(
    (
      await handle(
        request("/rpc/post/create", {
          method: "POST",
          body: "x",
          headers: { "content-length": String(RPC_MAX_BODY_BYTES + 1) },
        }),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await handle(
        request("/rpc/post/create", {
          method: "POST",
          body: "x".repeat(RPC_SMALL_BODY_BYTES + 1),
          headers: { "content-length": "1" },
        }),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await handle(
        request("/rpc/post/create", {
          method: "POST",
          body: "ok",
          headers: { "content-length": "2" },
        }),
      )
    ).status,
  ).toBe(200);
});

it("keeps appeal bodies small even when encoded or sent without a declared length", async () => {
  const handle = await fixture();
  expect(
    (await handle(request("/rpc/moderation%2FappealOpen", { method: "POST", body: "{}" }))).status,
  ).toBe(411);
  expect(
    (
      await handle(
        request("/rpc/moderation/appealOpen", {
          method: "POST",
          body: "{}",
          headers: { "content-length": String(RPC_SMALL_BODY_BYTES + 1) },
        }),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await handle(
        request("/rpc/moderation/appealOpen", {
          method: "POST",
          body: "{}",
          headers: { "content-length": "2" },
        }),
      )
    ).status,
  ).toBe(200);
});

it("admits auth before buffering and bounds both declared and lengthless auth payloads", async () => {
  const handle = await fixture();
  expect(
    (
      await handle(
        request("/api/auth/sign-in/email", {
          method: "POST",
          body: "x",
          headers: { "content-length": String(WORKER_AUTH_MAX_BODY_BYTES + 1) },
        }),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await handle(
        request("/api/auth/sign-in/email", {
          method: "POST",
          body: "x".repeat(WORKER_AUTH_MAX_BODY_BYTES + 1),
        }),
      )
    ).status,
  ).toBe(413);
  let cancelled = false;
  const denied = await fixture({
    handleAuth: () => Promise.resolve(new Response("Too many requests", { status: 429 })),
  });
  expect(
    (
      await denied(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: accessHeaders,
          body: new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          duplex: "half",
        }),
      )
    ).status,
  ).toBe(429);
  expect(cancelled).toBe(true);
});

it("bounds simultaneous large uploads while allowing small RPCs and releases admission after failure", async () => {
  let notifyStarted!: () => void;
  let notifyFinished!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    notifyFinished = resolve;
  });
  const handle = await fixture({
    async handleRpc(request) {
      if ((await request.text()).length > RPC_SMALL_BODY_BYTES) {
        notifyStarted();
        await finish;
        throw new Error("synthetic upload failure");
      }
      return new Response("small RPC");
    },
  });
  const upload = () =>
    request("/rpc/profile/uploadImage", {
      method: "POST",
      body: "x".repeat(RPC_SMALL_BODY_BYTES + 1),
      headers: {
        cookie: "__Secure-better-auth.session_token=valid",
        "content-length": String(RPC_SMALL_BODY_BYTES + 1),
      },
    });
  const pending = handle(upload());
  await started;
  expect((await handle(upload())).status).toBe(503);
  expect((await handle(request("/rpc/post/list"))).status).toBe(200);
  notifyFinished();
  expect((await pending).status).toBe(500);
  expect((await handle(upload())).status).toBe(500);
});

it("fails media closed on a session outage while allowing only the page shell", async () => {
  const handle = await fixture({ resolveSession: () => Promise.resolve({ kind: "unavailable" }) });
  const headers = { cookie: "__Secure-better-auth.session_token=valid" };
  expect((await handle(request("/media/private.jpg", { headers }))).status).toBe(503);
  expect((await handle(request("/settings", { headers }))).status).toBe(200);
  expect((await handle(request("/media/public.jpg"))).status).toBe(200);
  expect((await handle(request("/media/public.jpg", { method: "POST" }))).status).toBe(405);
});

it("preserves public page exceptions, gated redirects, public heads and missing asset 404s", async () => {
  const handle = await fixture();
  for (const path of [...SIGNED_OUT_PATHS, "/post/public-id", "/games/public-game"]) {
    const response = await handle(request(path));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Public metadata");
  }
  const gated = await handle(request("/settings?tab=profile.js"));
  expect(gated.status).toBe(302);
  expect(gated.headers.get("location")).toBe("/login?redirect=%2Fsettings%3Ftab%3Dprofile.js");
  expect((await handle(request("/assets/missing.js"))).status).toBe(404);
  expect(
    (
      await handle(
        request("/assets/missing", { headers: { cookie: "better-auth.session_token=valid" } }),
      )
    ).status,
  ).toBe(404);
  expect((await handle(request("/api/missing"))).status).toBe(404);
});

it("adds security headers and safe cache defaults to errors, preserves asset caching and strips HEAD bodies", async () => {
  const handle = await fixture();
  const response = await handle(request("/assets/missing.js", { method: "HEAD" }));
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toContain(
    "media-src 'self' blob: https://customer-test.cloudflarestream.com",
  );
  expect(response.headers.get("content-security-policy")).not.toContain("script-src 'self' blob:");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await handle(request("/assets/ok.js"))).headers.get("cache-control")).toContain(
    "immutable",
  );
});

it("never reports query tokens or raw dependency errors", async () => {
  const events: object[] = [];
  const handle = await fixture({
    handleRpc: () => Promise.reject(new Error("private SQL values")),
    observe: (event) => {
      events.push(event);
    },
  });
  const response = await handle(request("/rpc/post/list?token=private-capability"));
  expect(response.status).toBe(500);
  expect(await response.text()).toBe("Internal server error");
  expect(events).toEqual([
    { event: "request_failed", requestId: response.headers.get("x-request-id") },
  ]);
});
