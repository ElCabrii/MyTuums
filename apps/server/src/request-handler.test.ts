import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RPC_MAX_BODY_BYTES } from "@my-tuums/api/constants";
import { createRequestHandler, type RequestHandlerDeps } from "./request-handler.js";

/**
 * A response double that records what was written, matching only the
 * `ServerResponse` surface `request-handler.ts` actually touches. Real
 * `ServerResponse` objects are event-emitter-backed sockets — nothing this
 * module needs.
 */
function resStub() {
  const calls = { statusCode: undefined as number | undefined, headers: undefined as unknown, body: "" };
  let destroyed = false;

  const res = {
    get headersSent() {
      return calls.statusCode !== undefined;
    },
    writeHead: vi.fn((status: number, headers?: unknown) => {
      calls.statusCode = status;
      calls.headers = headers;
      return res;
    }),
    end: vi.fn((body?: string) => {
      if (body) calls.body = body;
      return res;
    }),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
  };

  return { res: res as unknown as ServerResponse, calls, isDestroyed: () => destroyed };
}

function reqStub(
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage;
}

/** A representative media hit: a URL plus the signing-window cache budget. */
const MEDIA_HIT = { url: "https://bucket.example/signed?sig=abc", cacheSeconds: 300 };

function deps(overrides: Partial<RequestHandlerDeps> = {}): RequestHandlerDeps {
  return {
    pingDb: vi.fn().mockResolvedValue(undefined),
    authNodeHandler: vi.fn().mockResolvedValue(undefined),
    handleRpc: vi.fn().mockResolvedValue({ matched: true }),
    // Defaults to "no such object", which is also what an unconfigured bucket
    // produces — the tests that care about a hit override it.
    resolveMediaUrl: vi.fn().mockResolvedValue(null),
    // Defaults to "this deployment serves no static files", which is exactly
    // what `pnpm dev` does — Vite serves the app and proxies here.
    serveStatic: vi.fn().mockResolvedValue({ served: false }),
    ...overrides,
  };
}

describe("createRequestHandler", () => {
  it("responds 200 with status ok when the database is reachable", async () => {
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps());

    await handle(reqStub("/health"), res);

    expect(calls.statusCode).toBe(200);
    expect(JSON.parse(calls.body)).toEqual({ status: "ok" });
  });

  it("responds 503 when pingDb rejects, rather than letting the request hang or 500", async () => {
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps({ pingDb: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) }));

    await handle(reqStub("/health"), res);

    expect(calls.statusCode).toBe(503);
    expect(JSON.parse(calls.body)).toEqual({ status: "error", reason: "database unreachable" });
  });

  it("redirects a cookie-less GET to / to /login, skipping the whole SPA round trip", async () => {
    // The client-side gate (`useRequireSignedIn`) would land a signed-out
    // visitor on /login?redirect=%2F anyway, but only after the bundle, the
    // splash and a /get-session round trip. The server can make that call
    // statelessly for the no-cookie case.
    const { res, calls } = resStub();
    const serveStatic = vi.fn().mockResolvedValue({ served: false });
    const handle = createRequestHandler(deps({ serveStatic }));

    await handle(reqStub("/"), res);

    expect(calls.statusCode).toBe(302);
    expect(calls.headers).toMatchObject({ Location: "/login?redirect=%2F" });
    expect(serveStatic).not.toHaveBeenCalled();
  });

  it("does NOT redirect when a session cookie is present — the app decides for stale sessions", async () => {
    // A present-but-expired cookie is indistinguishable from a live one here;
    // letting the request through is what the app has always done, and the
    // client gate handles the stale case without this server knowing.
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps());

    await handle(reqStub("/", "GET", { cookie: "better-auth.session_token=stale" }), res);

    expect(calls.statusCode).toBe(404);
  });

  it("does NOT redirect when the production __Secure- session cookie is present", async () => {
    // Over HTTPS, BetterAuth prefixes the cookie `__Secure-`, so production
    // sends `__Secure-better-auth.session_token`, never the bare name. The
    // check must recognise that shape — before the fix, every production
    // visitor at `/`, logged in or not, was 302'd to /login?redirect=%2F and
    // the login page bounced the live session back (reload flicker).
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps());

    await handle(reqStub("/", "GET", { cookie: "__Secure-better-auth.session_token=stale" }), res);

    expect(calls.statusCode).toBe(404);
  });

  it("redirects only the exact path /, not /?x=1 — consistent with the /health exact match", async () => {
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps());

    await handle(reqStub("/?x=1"), res);

    expect(calls.statusCode).toBe(404);
  });

  it("treats /health as an EXACT match — a query string is a different, unmatched route", async () => {
    // The real server checks `req.url === "/health"`, not a prefix. A probe
    // hitting "/health?x=1" should get the ordinary 404, not the health
    // response — this pins that down rather than a startsWith that would
    // silently accept it.
    const { res, calls } = resStub();
    const pingDb = vi.fn();
    const handle = createRequestHandler(deps({ pingDb }));

    await handle(reqStub("/health?x=1"), res);

    expect(pingDb).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(404);
  });

  it("dispatches /api/auth* to the BetterAuth handler and returns without falling through", async () => {
    const { res } = resStub();
    const authNodeHandler = vi.fn().mockResolvedValue(undefined);
    const handleRpc = vi.fn();
    const handle = createRequestHandler(deps({ authNodeHandler, handleRpc }));

    await handle(reqStub("/api/auth/sign-in/email", "POST"), res);

    expect(authNodeHandler).toHaveBeenCalledOnce();
    expect(handleRpc).not.toHaveBeenCalled();
  });

  it("rejects an oversized RPC body with 413 before handleRpc ever runs", async () => {
    // oRPC buffers a multipart body before auth, rate limiting or any payload
    // check — so the ceiling must hold in the router, ahead of everything. The
    // handler must not even be reached: the point of the check is that a body
    // that would be buffered never starts being buffered.
    const { res, calls } = resStub();
    const handleRpc = vi.fn();
    const handle = createRequestHandler(deps({ handleRpc }));

    await handle(reqStub("/rpc/user.uploadImage", "POST", {
      "content-length": String(RPC_MAX_BODY_BYTES + 1),
    }), res);

    expect(handleRpc).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(413);
    expect(calls.body).toBe("Payload too large");
  });

  it("accepts an RPC body at exactly the ceiling", async () => {
    const { res, calls } = resStub();
    const handleRpc = vi.fn().mockImplementation((_req: unknown, r: ServerResponse) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end("{}");
      return Promise.resolve({ matched: true });
    });
    const handle = createRequestHandler(deps({ handleRpc }));

    await handle(reqStub("/rpc/user.uploadImage", "POST", {
      "content-length": String(RPC_MAX_BODY_BYTES),
    }), res);

    expect(handleRpc).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(200);
  });

  it("dispatches /rpc* to handleRpc and returns when matched", async () => {
    const { res, calls } = resStub();
    const handleRpc = vi.fn().mockImplementation((_req: unknown, r: ServerResponse) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end("{}");
      return Promise.resolve({ matched: true });
    });
    const handle = createRequestHandler(deps({ handleRpc }));

    await handle(reqStub("/rpc/post.list"), res);

    expect(handleRpc).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(200);
  });

  it("falls through to 404 when handleRpc reports no match under /rpc", async () => {
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps({ handleRpc: vi.fn().mockResolvedValue({ matched: false }) }));

    await handle(reqStub("/rpc/does.not.exist"), res);

    expect(calls.statusCode).toBe(404);
    expect(calls.body).toBe("Not found");
  });

  it("redirects a /media hit to the presigned URL, cached privately for the window", async () => {
    const { res, calls } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue(MEDIA_HIT);
    const handle = createRequestHandler(deps({ resolveMediaUrl }));

    await handle(reqStub("/media/avatars/user-1/abc.webp"), res);

    expect(resolveMediaUrl).toHaveBeenCalledWith("avatars/user-1/abc.webp");
    expect(calls.statusCode).toBe(302);
    expect(calls.headers).toMatchObject({
      Location: MEDIA_HIT.url,
      // Private, because the presigned URL it points at is a bearer credential:
      // a shared cache handing this to another viewer would hand out access.
      // The max-age is the resolver's signing-window budget, never beyond it.
      "Cache-Control": `private, max-age=${MEDIA_HIT.cacheSeconds}`,
    });
  });

  it("strips the query string before resolving a media key", async () => {
    const { res } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue({ ...MEDIA_HIT, url: "https://bucket.example/signed" });
    const handle = createRequestHandler(deps({ resolveMediaUrl }));

    await handle(reqStub("/media/avatars/user-1/abc.webp?v=2"), res);

    expect(resolveMediaUrl).toHaveBeenCalledWith("avatars/user-1/abc.webp");
  });

  it("decodes percent-escapes so an encoded separator cannot slip past the key check", async () => {
    const { res } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue(null);
    const handle = createRequestHandler(deps({ resolveMediaUrl }));

    await handle(reqStub("/media/avatars%2F..%2Fsecret.webp"), res);

    // The resolver must see the decoded form — that is what `isSafeObjectKey`
    // is written against. Checking the encoded string would let `%2F` through.
    expect(resolveMediaUrl).toHaveBeenCalledWith("avatars/../secret.webp");
  });

  it("responds 404 when the resolver rejects the key or no bucket is configured", async () => {
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps());

    await handle(reqStub("/media/avatars/../../etc/passwd"), res);

    expect(calls.statusCode).toBe(404);
    expect(calls.body).toBe("Not found");
  });

  it("refuses a write verb on /media rather than letting it reach object storage", async () => {
    const { res, calls } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue(MEDIA_HIT);
    const handle = createRequestHandler(deps({ resolveMediaUrl }));

    await handle(reqStub("/media/avatars/user-1/abc.webp", "DELETE"), res);

    expect(calls.statusCode).toBe(405);
    expect(calls.headers).toMatchObject({ Allow: "GET, HEAD" });
    expect(resolveMediaUrl).not.toHaveBeenCalled();
  });

  it("responds 404 with text/plain for any other path", async () => {
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps());

    await handle(reqStub("/nonsense"), res);

    expect(calls.statusCode).toBe(404);
    expect(calls.headers).toMatchObject({ "Content-Type": "text/plain" });
    expect(calls.body).toBe("Not found");
  });

  it("converts an unhandled exception into a 500 when nothing has been written yet", async () => {
    const { res, calls } = resStub();
    const handle = createRequestHandler(
      deps({ handleRpc: vi.fn().mockRejectedValue(new Error("boom")) }),
    );

    await handle(reqStub("/rpc/post.create", "POST"), res);

    expect(calls.statusCode).toBe(500);
    expect(JSON.parse(calls.body)).toEqual({ error: "Internal Server Error" });
  });

  it("destroys the socket instead of double-writing when headers are already sent", async () => {
    // A handler that starts a response and THEN throws — the safety net must
    // not attempt a second writeHead/end on an already-committed response.
    const { res, isDestroyed } = resStub();
    const handle = createRequestHandler(
      deps({
        handleRpc: vi.fn().mockImplementation((_req: unknown, r: ServerResponse) => {
          r.writeHead(200, { "Content-Type": "application/json" });
          throw new Error("boom after headers sent");
        }),
      }),
    );

    await handle(reqStub("/rpc/post.create", "POST"), res);

    expect(isDestroyed()).toBe(true);
  });
});
