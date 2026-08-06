import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RPC_MAX_BODY_BYTES, SIGNED_OUT_PATHS } from "@my-tuums/api/constants";
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

/**
 * The cookie header plus the `hasValidSession` override a signed-in request
 * needs for both gates (`/media` and pages) — pairs with `reqStub`'s headers
 * argument and `deps`'s override, so a test proving "this path is reachable
 * once signed in" doesn't have to repeat both by hand.
 */
function signedIn() {
  return {
    headers: { cookie: "better-auth.session_token=live" },
    hasValidSession: vi.fn().mockResolvedValue(true),
  };
}

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
    // Defaults to "no session" — the tests that care about a signed-in
    // visitor override it.
    hasValidSession: vi.fn().mockResolvedValue(false),
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

  it("redirects a cookie-less GET to / to /login, skipping the whole SPA round trip and any session lookup", async () => {
    // The client-side gate (`useRequireSignedIn`) would land a signed-out
    // visitor on /login?redirect=%2F anyway, but only after the bundle, the
    // splash and a /get-session round trip. The server makes that call
    // statelessly for the no-cookie case — cheap enough that it never has to
    // ask the session store at all.
    const { res, calls } = resStub();
    const serveStatic = vi.fn().mockResolvedValue({ served: false });
    const hasValidSession = vi.fn();
    const handle = createRequestHandler(deps({ serveStatic, hasValidSession }));

    await handle(reqStub("/"), res);

    expect(calls.statusCode).toBe(302);
    expect(calls.headers).toMatchObject({ Location: "/login?redirect=%2F" });
    expect(serveStatic).not.toHaveBeenCalled();
    expect(hasValidSession).not.toHaveBeenCalled();
  });

  it("redirects any other extension-less page path the same way, with its own path percent-encoded into the target", async () => {
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps());

    await handle(reqStub("/@alice"), res);

    expect(calls.statusCode).toBe(302);
    expect(calls.headers).toMatchObject({ Location: "/login?redirect=%2F%40alice" });
  });

  it("carries the query string into the redirect target too — pathname / for /?x=1, same as the /health exact-match rule below", async () => {
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps());

    await handle(reqStub("/?x=1"), res);

    expect(calls.statusCode).toBe(302);
    expect(calls.headers).toMatchObject({ Location: "/login?redirect=%2F%3Fx%3D1" });
  });

  it("treats /health as an EXACT match — a query string is a different, unmatched route that falls into the page gate", async () => {
    // The real server checks `req.url === "/health"`, not a prefix. A probe
    // hitting "/health?x=1" is not a health check — it is just another
    // extension-less path the page gate has an opinion on, so it redirects
    // exactly like any other. pingDb must never be called for it either way.
    const { res, calls } = resStub();
    const pingDb = vi.fn();
    const handle = createRequestHandler(deps({ pingDb }));

    await handle(reqStub("/health?x=1"), res);

    expect(pingDb).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(302);
  });

  it("checks the real session, not just the cookie's presence, before letting a page through — a stale or forged cookie still redirects", async () => {
    // The old `/`-only check treated "a cookie named right" as "signed in".
    // A stale or forged cookie is exactly the case that could never catch —
    // this is the whole reason the gate now asks the session store instead
    // of stopping at the cookie name.
    const { res, calls } = resStub();
    const hasValidSession = vi.fn().mockResolvedValue(false);
    const handle = createRequestHandler(deps({ hasValidSession }));

    await handle(reqStub("/@alice", "GET", { cookie: "better-auth.session_token=stale" }), res);

    expect(hasValidSession).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(302);
  });

  it("falls through to serveStatic when the cookie names a genuinely live session", async () => {
    const { res, calls } = resStub();
    const serveStatic = vi.fn().mockResolvedValue({ served: true });
    const handle = createRequestHandler(
      deps({ serveStatic, hasValidSession: vi.fn().mockResolvedValue(true) }),
    );

    await handle(reqStub("/@alice", "GET", { cookie: "better-auth.session_token=live" }), res);

    expect(serveStatic).toHaveBeenCalledOnce();
    expect(calls.statusCode).not.toBe(302);
  });

  it("recognises the production __Secure- session cookie prefix the same way", async () => {
    // Over HTTPS, BetterAuth prefixes the cookie `__Secure-`, so production
    // sends `__Secure-better-auth.session_token`, never the bare name. A
    // mismatch here would 302 *every* production visitor to /login, signed in
    // or not — see the doc comment on SESSION_COOKIE_NAME.
    const { res, calls } = resStub();
    const serveStatic = vi.fn().mockResolvedValue({ served: true });
    const handle = createRequestHandler(
      deps({ serveStatic, hasValidSession: vi.fn().mockResolvedValue(true) }),
    );

    await handle(
      reqStub("/@alice", "GET", { cookie: "__Secure-better-auth.session_token=live" }),
      res,
    );

    expect(serveStatic).toHaveBeenCalledOnce();
    expect(calls.statusCode).not.toBe(302);
  });

  it("never redirects a path on SIGNED_OUT_PATHS — the loop guard", async () => {
    // The allowlist is imported from the SAME module the client gate reads
    // (@my-tuums/api/constants), specifically so the two cannot drift apart.
    // A path gated here but not on the client — or exempted on the client but
    // not here — is a redirect loop waiting to happen: if /login itself were
    // ever gated, a signed-out visitor would bounce between this server and
    // /login forever. This test is what proves every member of the shared
    // list is actually exempt here, not just documented as intended to be.
    for (const allowedPath of SIGNED_OUT_PATHS) {
      const { res, calls } = resStub();
      const handle = createRequestHandler(deps());

      await handle(reqStub(allowedPath), res);

      expect(calls.statusCode, `expected ${allowedPath} not to redirect`).not.toBe(302);
    }
  });

  it("does not gate a static asset, even signed out — /login needs its own JS and CSS to render", async () => {
    // A gated asset would turn the redirect into a blank page: the browser
    // would land on /login with none of the bundle it needs to draw it.
    const { res, calls } = resStub();
    const serveStatic = vi.fn().mockResolvedValue({ served: true });
    const handle = createRequestHandler(deps({ serveStatic }));

    await handle(reqStub("/assets/index-abc123.js"), res);

    expect(serveStatic).toHaveBeenCalledOnce();
    expect(calls.statusCode).not.toBe(302);
  });

  it("does not gate a non-GET/HEAD request to a page path", async () => {
    const { res, calls } = resStub();
    const serveStatic = vi.fn().mockResolvedValue({ served: false });
    const handle = createRequestHandler(deps({ serveStatic }));

    await handle(reqStub("/@alice", "POST"), res);

    expect(calls.statusCode).not.toBe(302);
    expect(serveStatic).toHaveBeenCalledOnce();
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

  it("forwards a chunked RPC body to handleRpc — its cap lives in oRPC's BodyLimitPlugin", async () => {
    // A Transfer-Encoding request carries no Content-Length for the router
    // cap to read, and Node http clients legitimately send chunked when they
    // omit the header — so the router must not reject it. The byte-counting
    // cap for chunked bodies is oRPC's BodyLimitPlugin, wired in index.ts.
    const { res, calls } = resStub();
    const handleRpc = vi.fn().mockImplementation((_req: unknown, r: ServerResponse) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end("{}");
      return Promise.resolve({ matched: true });
    });
    const handle = createRequestHandler(deps({ handleRpc }));

    await handle(reqStub("/rpc/user.uploadImage", "POST", {
      "transfer-encoding": "chunked",
    }), res);

    expect(handleRpc).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(200);
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

  it("redirects a /media hit to the presigned URL, cached privately for the window — once signed in", async () => {
    const { res, calls } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue(MEDIA_HIT);
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ resolveMediaUrl, hasValidSession: session.hasValidSession }),
    );

    await handle(reqStub("/media/avatars/user-1/abc.webp", "GET", session.headers), res);

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
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ resolveMediaUrl, hasValidSession: session.hasValidSession }),
    );

    await handle(reqStub("/media/avatars/user-1/abc.webp?v=2", "GET", session.headers), res);

    expect(resolveMediaUrl).toHaveBeenCalledWith("avatars/user-1/abc.webp");
  });

  it("decodes percent-escapes so an encoded separator cannot slip past the key check", async () => {
    const { res } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue(null);
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ resolveMediaUrl, hasValidSession: session.hasValidSession }),
    );

    await handle(reqStub("/media/avatars%2F..%2Fsecret.webp", "GET", session.headers), res);

    // The resolver must see the decoded form — that is what `isSafeObjectKey`
    // is written against. Checking the encoded string would let `%2F` through.
    expect(resolveMediaUrl).toHaveBeenCalledWith("avatars/../secret.webp");
  });

  it("responds 404 when the resolver rejects the key or no bucket is configured — for a signed-in caller past the gate", async () => {
    const { res, calls } = resStub();
    const session = signedIn();
    const handle = createRequestHandler(deps({ hasValidSession: session.hasValidSession }));

    await handle(reqStub("/media/avatars/../../etc/passwd", "GET", session.headers), res);

    expect(calls.statusCode).toBe(404);
    expect(calls.body).toBe("Not found");
  });

  it("refuses an anonymous GET with 401, before the key is even parsed", async () => {
    // Deliberately a well-formed key: a 401 here (rather than a 404) is what
    // proves the session gate fired ahead of key validation, not that the key
    // happened to look wrong. An anonymous caller must not be able to learn
    // anything about which keys exist by watching how the response differs.
    const { res, calls } = resStub();
    const resolveMediaUrl = vi.fn();
    const handle = createRequestHandler(deps({ resolveMediaUrl }));

    await handle(reqStub("/media/avatars/user-1/abc.webp"), res);

    expect(resolveMediaUrl).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(401);
    expect(calls.headers).toMatchObject({ "Cache-Control": "no-store" });
  });

  it("refuses a GET whose cookie names a session that is not actually valid", async () => {
    const { res, calls } = resStub();
    const hasValidSession = vi.fn().mockResolvedValue(false);
    const handle = createRequestHandler(deps({ hasValidSession }));

    await handle(
      reqStub("/media/avatars/user-1/abc.webp", "GET", {
        cookie: "better-auth.session_token=stale",
      }),
      res,
    );

    expect(hasValidSession).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(401);
  });

  it("a rejecting hasValidSession hits the top-level safety net, not a silent fall-through — fail-open is index.ts's job, not this module's", async () => {
    // The `hasValidSession` contract (see its doc comment above) promises to
    // never reject — the real implementation in index.ts catches internally
    // and resolves `true` on error. This module has no special handling for a
    // broken contract: a rejection here propagates exactly like any other
    // unhandled exception, the same as the existing handleRpc-throws test
    // below. Fail-open is entirely index.ts's responsibility; that behaviour
    // is out of this file's reach to test (index.ts is deliberately excluded
    // from unit tests — see vitest.config.ts) and is instead verified by
    // reasoning about the try/catch in its own doc comment.
    const { res, calls } = resStub();
    const handle = createRequestHandler(
      deps({
        hasValidSession: vi.fn().mockRejectedValue(new Error("session store unreachable")),
      }),
    );

    await handle(
      reqStub("/media/avatars/user-1/abc.webp", "GET", {
        cookie: "better-auth.session_token=live",
      }),
      res,
    );

    expect(calls.statusCode).toBe(500);
  });

  it("refuses a write verb on /media rather than letting it reach object storage, even signed out", async () => {
    const { res, calls } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue(MEDIA_HIT);
    const handle = createRequestHandler(deps({ resolveMediaUrl }));

    await handle(reqStub("/media/avatars/user-1/abc.webp", "DELETE"), res);

    expect(calls.statusCode).toBe(405);
    expect(calls.headers).toMatchObject({ Allow: "GET, HEAD" });
    expect(resolveMediaUrl).not.toHaveBeenCalled();
  });

  it("responds 404 with text/plain for any other path serveStatic doesn't serve, once the page gate is satisfied", async () => {
    // A signed-out request to an extension-less path like this now hits the
    // page gate first and redirects (see the gate tests above) — this test is
    // about the fallback 404 underneath the gate, so it goes in signed in.
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps({ hasValidSession: vi.fn().mockResolvedValue(true) }));

    await handle(reqStub("/nonsense", "GET", { cookie: "better-auth.session_token=live" }), res);

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
