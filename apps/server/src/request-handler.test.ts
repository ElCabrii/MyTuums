import { describe, expect, it, vi } from "vitest";
import { IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { Socket } from "node:net";
import {
  RPC_MAX_BODY_BYTES,
  RPC_SMALL_BODY_BYTES,
  SIGNED_OUT_PATHS,
} from "@my-tuums/api/constants";
import {
  AUTH_MAX_BODY_BYTES,
  MAX_RPC_IN_FLIGHT,
  createRequestHandler,
  type AuthRequestSurface,
  type RequestHandlerDeps,
  type RequestResponse,
} from "./request-handler.js";

/**
 * A response double that records what was written, matching only the
 * `ServerResponse` surface `request-handler.ts` actually touches. Real
 * `ServerResponse` objects are event-emitter-backed sockets — nothing this
 * module needs.
 */
interface ResponseCalls {
  statusCode: number | undefined;
  headers: OutgoingHttpHeaders | undefined;
  body: string;
  headersSet: Record<string, string>;
}

class ResponseDouble implements RequestResponse {
  readonly calls: ResponseCalls = {
    statusCode: undefined,
    headers: undefined,
    body: "",
    // The setHeader state, keyed lowercase — `getHeader` reads it back, the
    // same contract Node's `ServerResponse` has (case-insensitive).
    headersSet: {},
  };
  destroyedByHandler = false;

  get headersSent(): boolean {
    return this.calls.statusCode !== undefined;
  }

  writeHead(statusCode: number, headers?: OutgoingHttpHeaders): this {
    this.calls.statusCode = statusCode;
    this.calls.headers = headers;
    return this;
  }

  end(body?: string): this {
    if (body) this.calls.body = body;
    return this;
  }

  destroy(): this {
    this.destroyedByHandler = true;
    return this;
  }

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.calls.headersSet[name.toLowerCase()] = String(value);
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.calls.headersSet[name.toLowerCase()];
  }
}

function resStub() {
  const res = new ResponseDouble();
  return {
    res,
    calls: res.calls,
    isDestroyed: () => res.destroyedByHandler,
  };
}

function reqStub(
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
): IncomingMessage {
  const request = new IncomingMessage(new Socket());
  request.url = url;
  request.method = method;
  request.headers = headers;
  // A real stream that is already at EOF, so readAuthBody resolves immediately.
  request.push(null);
  return request;
}

function streamReqStub(
  url: string,
  body: Buffer,
  method = "POST",
  headers: Record<string, string> = {},
): IncomingMessage {
  const request = new IncomingMessage(new Socket());
  request.url = url;
  request.method = method;
  request.headers = { ...headers, "transfer-encoding": "chunked" };
  request.push(body);
  request.push(null);
  return request;
}

/** A representative media hit: a URL plus the signing-window cache budget. */
const MEDIA_HIT = { url: "https://bucket.example/signed?sig=abc", cacheSeconds: 300 };

/**
 * The cookie header plus the `resolveSession` override a signed-in request
 * needs for both gates (`/media` and pages) — pairs with `reqStub`'s headers
 * argument and `deps`'s override, so a test proving "this path is reachable
 * once signed in" doesn't have to repeat both by hand.
 */
function signedIn(userId = "viewer-1") {
  return {
    headers: { cookie: "better-auth.session_token=live" },
    resolveSession: vi.fn().mockResolvedValue({ kind: "authenticated", userId }),
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
    resolveSession: vi.fn().mockResolvedValue({ kind: "anonymous" }),
    observeError: vi.fn().mockReturnValue({ action: "continue" }),
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
    const handle = createRequestHandler(
      deps({ pingDb: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) }),
    );

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
    const resolveSession = vi.fn();
    const handle = createRequestHandler(deps({ serveStatic, resolveSession }));

    await handle(reqStub("/"), res);

    expect(calls.statusCode).toBe(302);
    expect(calls.headers).toMatchObject({ Location: "/login?redirect=%2F" });
    expect(serveStatic).not.toHaveBeenCalled();
    expect(resolveSession).not.toHaveBeenCalled();
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
    const resolveSession = vi.fn().mockResolvedValue({ kind: "anonymous" });
    const handle = createRequestHandler(deps({ resolveSession }));

    await handle(reqStub("/@alice", "GET", { cookie: "better-auth.session_token=stale" }), res);

    expect(resolveSession).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(302);
  });

  it("falls through to serveStatic when the cookie names a genuinely live session", async () => {
    const { res, calls } = resStub();
    const serveStatic = vi.fn().mockResolvedValue({ served: true });
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ serveStatic, resolveSession: session.resolveSession }),
    );

    await handle(reqStub("/@alice", "GET", { cookie: "better-auth.session_token=live" }), res);

    expect(serveStatic).toHaveBeenCalledOnce();
    expect(calls.statusCode).not.toBe(302);
  });

  it("fails the page gate open when the session store is unavailable", async () => {
    const { res, calls } = resStub();
    const serveStatic = vi.fn().mockResolvedValue({ served: true });
    const resolveSession = vi.fn().mockResolvedValue({ kind: "unavailable" });
    const handle = createRequestHandler(deps({ serveStatic, resolveSession }));

    await handle(reqStub("/@alice", "GET", { cookie: "better-auth.session_token=live" }), res);

    expect(resolveSession).toHaveBeenCalledOnce();
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
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ serveStatic, resolveSession: session.resolveSession }),
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

  it("keeps /appeal on SIGNED_OUT_PATHS — the signed-out appeal link must never be gated", () => {
    // The moderation appeal flow is the one surface a banned user has, and
    // it is the load-bearing member of the shared list: remove it here and
    // the email link bounces to /login with no test noticing (the loop
    // guard above only iterates whatever the list contains). Pinned so a
    // removal is a deliberate act, not an accident.
    expect(SIGNED_OUT_PATHS).toContain("/appeal");
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

  it("rejects an oversized declared auth body before Better Auth runs", async () => {
    const { res, calls } = resStub();
    const authNodeHandler = vi.fn();
    const handle = createRequestHandler(deps({ authNodeHandler }));

    await handle(
      reqStub("/api/auth/sign-in/email", "POST", {
        "content-length": String(AUTH_MAX_BODY_BYTES + 1),
      }),
      res,
    );

    expect(authNodeHandler).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(413);
    expect(calls.body).toBe("Payload too large");
  });

  it("rejects a chunked auth body when streamed bytes cross the limit", async () => {
    const { res, calls } = resStub();
    const authNodeHandler = vi.fn();
    const handle = createRequestHandler(deps({ authNodeHandler }));

    await handle(
      streamReqStub("/api/auth/sign-in/email", Buffer.alloc(AUTH_MAX_BODY_BYTES + 1)),
      res,
    );

    expect(authNodeHandler).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(413);
    expect(calls.body).toBe("Payload too large");
  });

  it("replays a chunked auth body at exactly the limit to Better Auth", async () => {
    const { res, calls } = resStub();
    const received: Buffer[] = [];
    const authNodeHandler = vi.fn(async (req: AuthRequestSurface, response: RequestResponse) => {
      for await (const chunk of req) {
        received.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      response.writeHead(200);
      response.end("ok");
    });
    const handle = createRequestHandler(deps({ authNodeHandler }));
    const body = Buffer.alloc(AUTH_MAX_BODY_BYTES, 0x61);

    await handle(streamReqStub("/api/auth/sign-in/email", body), res);

    expect(authNodeHandler).toHaveBeenCalledOnce();
    // Native Buffer comparison avoids Vitest recursively walking one million
    // numeric properties, which can exceed the default timeout when workspace
    // test packages run concurrently.
    expect(Buffer.concat(received).equals(body)).toBe(true);
    expect(calls.statusCode).toBe(200);
  });

  it("404s /api/auth/admin/* without reaching the BetterAuth handler", async () => {
    // The admin plugin's endpoints gate on adminRoles only and can't express
    // the staff-vs-admin hierarchy — every moderation action must go through
    // the /rpc procedures, which enforce it and write the audit log. The
    // plugin's own routes being unreachable is what makes that single
    // enforcement point real rather than aspirational.
    const { res, calls } = resStub();
    const authNodeHandler = vi.fn().mockResolvedValue(undefined);
    const handle = createRequestHandler(deps({ authNodeHandler }));

    await handle(reqStub("/api/auth/admin/ban-user", "POST"), res);

    expect(authNodeHandler).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(404);
    expect(calls.body).toBe("Not found");
  });

  it("404s every canonical spelling of an admin route, not just the literal one", async () => {
    // The denylist compares the CANONICALIZED path — decoded, dot segments
    // resolved, slashes collapsed — because better-auth routes on that form.
    // Each of these decodes/normalizes to `/api/auth/admin/...` while having
    // a raw spelling that a plain startsWith would let past: an encoded
    // slash, an encoded letter, a doubled slash, an encoded dot segment, and
    // the bare prefix with no trailing slash.
    const adminSpellings = [
      "/api/auth/admin",
      "/api/auth/admin/",
      "/api/auth/admin%2Fban-user",
      "/api/auth/admin%2fban-user",
      "/api/auth/%61dmin/ban-user",
      "/api/auth//admin/ban-user",
      // Dot segments — literal and fully encoded — whose cancellation lands
      // back on the admin prefix: the four `..` cancel `api/auth/admin`.
      "/api/auth/admin/../../../../api/auth/admin/list-users",
      "/api/auth/admin%2f..%2f..%2f..%2f..%2fapi%2fauth%2fadmin%2fban-user",
    ];
    for (const url of adminSpellings) {
      const { res, calls } = resStub();
      const authNodeHandler = vi.fn().mockResolvedValue(undefined);
      const handle = createRequestHandler(deps({ authNodeHandler }));

      await handle(reqStub(url, "POST"), res);

      expect(authNodeHandler, `expected ${url} to be denied`).not.toHaveBeenCalled();
      expect(calls.statusCode, `expected ${url} to 404`).toBe(404);
    }
  });

  it("still passes a non-admin /api/auth path through, even one whose raw spelling contains a dot segment", async () => {
    // The canonical form of /api/auth/admin/../get-session is
    // /api/auth/get-session — not an admin route, so the denylist must not
    // touch it. Over-blocking here would be its own regression: a legitimate
    // auth path that happens to normalize oddly must still reach BetterAuth.
    const { res } = resStub();
    const authNodeHandler = vi.fn().mockResolvedValue(undefined);
    const handle = createRequestHandler(deps({ authNodeHandler }));

    await handle(reqStub("/api/auth/admin/../get-session", "GET"), res);

    expect(authNodeHandler).toHaveBeenCalledOnce();
  });

  it("rejects an oversized RPC body with 413 before handleRpc ever runs", async () => {
    // oRPC buffers a multipart body before auth, rate limiting or any payload
    // check — so the ceiling must hold in the router, ahead of everything. The
    // handler must not even be reached: the point of the check is that a body
    // that would be buffered never starts being buffered.
    const { res, calls } = resStub();
    const handleRpc = vi.fn();
    const handle = createRequestHandler(deps({ handleRpc }));

    await handle(
      reqStub("/rpc/user.uploadImage", "POST", {
        "content-length": String(RPC_MAX_BODY_BYTES + 1),
      }),
      res,
    );

    expect(handleRpc).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(413);
    expect(calls.body).toBe("Payload too large");
  });

  it("accepts an upload-sized RPC body at exactly the ceiling once signed in", async () => {
    // Above RPC_SMALL_BODY_BYTES the router demands a valid session before a
    // non-appeal body is buffered — a body this large is an upload by
    // definition, and uploads are session-gated. The ceiling itself is still
    // the streaming hard cap.
    const { res, calls } = resStub();
    const handleRpc = vi.fn().mockImplementation((_req: IncomingMessage, r: RequestResponse) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end("{}");
      return Promise.resolve({ matched: true });
    });
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ handleRpc, resolveSession: session.resolveSession }),
    );

    await handle(
      reqStub("/rpc/user.uploadImage", "POST", {
        "content-length": String(RPC_MAX_BODY_BYTES),
        ...session.headers,
      }),
      res,
    );

    expect(handleRpc).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(200);
  });

  it("refuses an upload-sized non-appeal body with 401 before handleRpc, when no session cookie is present", async () => {
    // The pre-auth gate: a declared body above RPC_SMALL_BODY_BYTES on any
    // path other than the public appeal surface is an upload by definition,
    // and every upload is session-gated. Refusing it before oRPC parses it is
    // what stops an anonymous upload-sized body from ever being buffered. The
    // cookie pre-check must keep the session store out of it.
    const { res, calls } = resStub();
    const handleRpc = vi.fn();
    const resolveSession = vi.fn();
    const handle = createRequestHandler(deps({ handleRpc, resolveSession }));

    await handle(
      reqStub("/rpc/user.uploadImage", "POST", {
        "content-length": String(RPC_SMALL_BODY_BYTES + 1),
      }),
      res,
    );

    expect(resolveSession).not.toHaveBeenCalled();
    expect(handleRpc).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(401);
    expect(calls.body).toBe("Unauthorized");
  });

  it("refuses an upload-sized body with 401 even with a stale session cookie — and only then pays for the session lookup", async () => {
    // A cookie is not a session; the gate must fail closed on whatever the
    // session store says, including an unavailable one. The cookie only earns
    // the lookup, it does not skip it.
    const { res, calls } = resStub();
    const handleRpc = vi.fn();
    const handle = createRequestHandler(
      deps({
        handleRpc,
        resolveSession: vi.fn().mockResolvedValue({ kind: "unavailable" }),
      }),
    );

    await handle(
      reqStub("/rpc/user.uploadImage", "POST", {
        "content-length": String(RPC_SMALL_BODY_BYTES + 1),
        cookie: "better-auth.session_token=stale",
      }),
      res,
    );

    expect(handleRpc).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(401);
  });

  it("lets a signed-in upload-sized non-appeal body through to handleRpc", async () => {
    const { res, calls } = resStub();
    const handleRpc = vi.fn().mockImplementation((_req: IncomingMessage, r: RequestResponse) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end("{}");
      return Promise.resolve({ matched: true });
    });
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ handleRpc, resolveSession: session.resolveSession }),
    );

    await handle(
      reqStub("/rpc/user.uploadImage", "POST", {
        "content-length": String(RPC_SMALL_BODY_BYTES + 1),
        ...session.headers,
      }),
      res,
    );

    expect(session.resolveSession).toHaveBeenCalledOnce();
    expect(handleRpc).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(200);
  });

  it("refuses an oversized appeal body with 413 — the appeal surface keeps its own low limit", async () => {
    // The one anonymous procedure is small by construction (token 4 KiB plus a
    // 2000-character reason), so it gets its own low ceiling instead of being
    // handed to the session demand — the person appealing cannot sign in.
    const { res, calls } = resStub();
    const handleRpc = vi.fn();
    const handle = createRequestHandler(deps({ handleRpc }));

    await handle(
      reqStub("/rpc/moderation/appealOpen", "POST", {
        "content-length": String(RPC_SMALL_BODY_BYTES + 1),
      }),
      res,
    );

    expect(handleRpc).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(413);
    expect(calls.body).toBe("Payload too large");
  });

  it("holds the appeal limit on an encoded spelling of the appeal path, and lets a small appeal body through", async () => {
    // The gate judges the canonical path, so a percent-encoded segment can
    // neither escape the appeal surface's low limit nor be mistaken for a
    // different procedure. A body that fails to canonicalise at all falls to
    // the session demand, which is the closed direction.
    const { res, calls } = resStub();
    const handleRpc = vi.fn().mockImplementation((_req: IncomingMessage, r: RequestResponse) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end("{}");
      return Promise.resolve({ matched: true });
    });
    const handle = createRequestHandler(deps({ handleRpc }));

    await handle(
      reqStub("/rpc/moderation%2FappealOpen", "POST", {
        "content-length": String(RPC_SMALL_BODY_BYTES + 1),
      }),
      res,
    );
    expect(handleRpc).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(413);

    // A body within the appeal limit passes straight through to the router:
    // the public surface stays reachable by the signed-out person it exists for.
    const { res: resSmall, calls: callsSmall } = resStub();
    await handle(
      reqStub("/rpc/moderation/appealOpen", "POST", { "content-length": "100" }),
      resSmall,
    );
    expect(handleRpc).toHaveBeenCalledOnce();
    expect(callsSmall.statusCode).toBe(200);
  });

  it("sends a small body through to handleRpc without touching the session store", async () => {
    // The whole point of the pre-auth gate is that only upload-sized bodies
    // pay for it; ordinary JSON stays on the fast path.
    const { res, calls } = resStub();
    const handleRpc = vi.fn().mockImplementation((_req: IncomingMessage, r: RequestResponse) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end("{}");
      return Promise.resolve({ matched: true });
    });
    const resolveSession = vi.fn();
    const handle = createRequestHandler(deps({ handleRpc, resolveSession }));

    await handle(reqStub("/rpc/post.list", "GET", { "content-length": "40" }), res);

    expect(resolveSession).not.toHaveBeenCalled();
    expect(handleRpc).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(200);
  });

  it("dispatches /rpc* to handleRpc and returns when matched", async () => {
    const { res, calls } = resStub();
    const handleRpc = vi.fn().mockImplementation((_req: IncomingMessage, r: RequestResponse) => {
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
    const handle = createRequestHandler(
      deps({ handleRpc: vi.fn().mockResolvedValue({ matched: false }) }),
    );

    await handle(reqStub("/rpc/does.not.exist"), res);

    expect(calls.statusCode).toBe(404);
    expect(calls.body).toBe("Not found");
  });

  it("refuses an anonymous chunked body with 401 before handleRpc, without touching the session store", async () => {
    // A chunked body carries no Content-Length for either size check to read,
    // so it is treated as over the small-body line by definition: same demand,
    // same refusal, and the same cookie pre-check keeping the session store
    // out of it. Without this, a missing header would buy what a big declared
    // body cannot — an unbounded-looking buffered request from an anonymous
    // caller.
    const { res, calls } = resStub();
    const handleRpc = vi.fn();
    const resolveSession = vi.fn();
    const handle = createRequestHandler(deps({ handleRpc, resolveSession }));

    await handle(streamReqStub("/rpc/user.uploadImage", Buffer.alloc(16)), res);

    expect(resolveSession).not.toHaveBeenCalled();
    expect(handleRpc).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(401);
    expect(calls.body).toBe("Unauthorized");
  });

  it("refuses an anonymous chunked appeal body with 411 rather than admitting it to buffer", async () => {
    // The one public surface cannot be asked for a session, and a chunked
    // body gives the gate no length to compare either — there is no version
    // of that request it can admit. Every legitimate appeal client (a browser
    // following the email link) sends plain JSON with a Content-Length, so
    // refusing the encoding costs nothing real and closes the last anonymous
    // path to a router-sized buffer.
    const { res, calls } = resStub();
    const handleRpc = vi.fn();
    const handle = createRequestHandler(deps({ handleRpc }));

    await handle(streamReqStub("/rpc/moderation/appealOpen", Buffer.alloc(16)), res);

    expect(handleRpc).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(411);
    expect(calls.body).toBe("Length required");
  });

  it("lets a signed-in chunked body through to handleRpc", async () => {
    // Node http clients legitimately omit Content-Length; the gate demands a
    // session for exactly those bodies and then admits them like any other.
    const { res, calls } = resStub();
    const handleRpc = vi.fn().mockImplementation((_req: IncomingMessage, r: RequestResponse) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end("{}");
      return Promise.resolve({ matched: true });
    });
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ handleRpc, resolveSession: session.resolveSession }),
    );

    await handle(
      streamReqStub("/rpc/user.uploadImage", Buffer.alloc(16), "POST", session.headers),
      res,
    );

    expect(session.resolveSession).toHaveBeenCalledOnce();
    expect(handleRpc).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(200);
  });

  it("refuses /rpc with 503 once MAX_RPC_IN_FLIGHT dispatches are already buffering, and admits again as they finish", async () => {
    // The backpressure that bounds how many router-sized buffers can exist at
    // once. After the pre-auth gate, only a SIGNED-IN caller can put a
    // lengthless or upload-sized body in flight at all, so these requests
    // carry the session the gate demands; an anonymous flood is turned away at
    // 401 long before this counter matters. The release proves it is a live
    // counter, not a one-way latch.
    const release: (() => void)[] = [];
    const handleRpc = vi.fn().mockImplementation(
      () =>
        new Promise<{ matched: boolean }>((resolve) => {
          release.push(() => {
            resolve({ matched: true });
          });
        }),
    );
    const session = signedIn("uploader-1");
    const handle = createRequestHandler(
      deps({ handleRpc, resolveSession: session.resolveSession }),
    );
    const request = () =>
      reqStub("/rpc/user.uploadImage", "POST", {
        "transfer-encoding": "chunked",
        ...session.headers,
      });

    const inFlight = Array.from({ length: MAX_RPC_IN_FLIGHT }, () => {
      const { res } = resStub();
      return handle(request(), res);
    });
    // Let each admitted dispatch reach its pending handleRpc call.
    await Promise.resolve();
    expect(handleRpc).toHaveBeenCalledTimes(MAX_RPC_IN_FLIGHT);

    const { res: refused, calls: refusedCalls } = resStub();
    await handle(request(), refused);
    expect(handleRpc).toHaveBeenCalledTimes(MAX_RPC_IN_FLIGHT);
    expect(refusedCalls.statusCode).toBe(503);
    expect(refusedCalls.body).toBe("Server busy");

    for (const resolve of release) resolve();
    await Promise.all(inFlight);

    const { res: after, calls: afterCalls } = resStub();
    const admitted = handle(request(), after);
    await Promise.resolve();
    expect(handleRpc).toHaveBeenCalledTimes(MAX_RPC_IN_FLIGHT + 1);
    release[release.length - 1]?.();
    await admitted;
    expect(afterCalls.statusCode).toBeUndefined();
  });

  it("redirects a /media hit to the presigned URL, privately for the window — once signed in", async () => {
    const { res, calls } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue(MEDIA_HIT);
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ resolveMediaUrl, resolveSession: session.resolveSession }),
    );

    await handle(reqStub("/media/avatars/user-1/abc.webp", "GET", session.headers), res);

    expect(resolveMediaUrl).toHaveBeenCalledWith("avatars/user-1/abc.webp", "viewer-1");
    expect(calls.statusCode).toBe(302);
    expect(calls.headers).toMatchObject({
      Location: MEDIA_HIT.url,
      // Private, because the presigned URL it points at is a bearer credential:
      // a shared cache handing this to another viewer would hand out access.
      // The max-age is the resolver's signing-window budget, never beyond it.
      "Cache-Control": `private, max-age=${MEDIA_HIT.cacheSeconds}`,
    });
  });

  it("passes the authenticated viewer to post-media authorization", async () => {
    const { res, calls } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue(MEDIA_HIT);
    const session = signedIn();
    const handle = createRequestHandler(
      deps({
        resolveMediaUrl,
        resolveSession: session.resolveSession,
      }),
    );

    await handle(
      reqStub("/media/posts/author-1/post-1/attachment-1.png", "GET", session.headers),
      res,
    );

    expect(session.resolveSession).toHaveBeenCalledOnce();
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      "posts/author-1/post-1/attachment-1.png",
      "viewer-1",
    );
    expect(calls.statusCode).toBe(302);
    expect(calls.headers).toMatchObject({ "Cache-Control": "private, no-store" });
  });

  it("strips the query string before resolving a media key", async () => {
    const { res } = resStub();
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValue({ ...MEDIA_HIT, url: "https://bucket.example/signed" });
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ resolveMediaUrl, resolveSession: session.resolveSession }),
    );

    await handle(reqStub("/media/avatars/user-1/abc.webp?v=2", "GET", session.headers), res);

    expect(resolveMediaUrl).toHaveBeenCalledWith("avatars/user-1/abc.webp", "viewer-1");
  });

  it("decodes percent-escapes so an encoded separator cannot slip past the key check", async () => {
    const { res } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue(null);
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ resolveMediaUrl, resolveSession: session.resolveSession }),
    );

    await handle(reqStub("/media/avatars%2F..%2Fsecret.webp", "GET", session.headers), res);

    // The resolver must see the decoded form — that is what `isSafeObjectKey`
    // is written against. Checking the encoded string would let `%2F` through.
    expect(resolveMediaUrl).toHaveBeenCalledWith("avatars/../secret.webp", "viewer-1");
  });

  it("responds 404 when the resolver rejects the key or no bucket is configured — for a signed-in caller past the gate", async () => {
    const { res, calls } = resStub();
    const session = signedIn();
    const handle = createRequestHandler(deps({ resolveSession: session.resolveSession }));

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
    const resolveSession = vi.fn().mockResolvedValue({ kind: "anonymous" });
    const handle = createRequestHandler(deps({ resolveSession }));

    await handle(
      reqStub("/media/avatars/user-1/abc.webp", "GET", {
        cookie: "better-auth.session_token=stale",
      }),
      res,
    );

    expect(resolveSession).toHaveBeenCalledOnce();
    expect(calls.statusCode).toBe(401);
  });

  it("fails profile media closed when the session store cannot establish a viewer", async () => {
    const { res, calls } = resStub();
    const resolveMediaUrl = vi.fn();
    const handle = createRequestHandler(
      deps({
        resolveMediaUrl,
        resolveSession: vi.fn().mockResolvedValue({ kind: "unavailable" }),
      }),
    );

    await handle(
      reqStub("/media/avatars/user-1/abc.webp", "GET", {
        cookie: "better-auth.session_token=live",
      }),
      res,
    );

    // An unavailable lookup yields a cookie but no viewer identity, and every
    // media key — profile included — is authorized per viewer. No viewer, no
    // object: fail closed rather than fall back to a viewer-less resolution.
    expect(resolveMediaUrl).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(503);
    expect(calls.headers).toMatchObject({ "Cache-Control": "no-store" });
  });

  it("serves a profile original to the signed-in viewer, but never caches the redirect", async () => {
    const { res, calls } = resStub();
    const resolveMediaUrl = vi.fn().mockResolvedValue(MEDIA_HIT);
    const session = signedIn();
    const handle = createRequestHandler(
      deps({ resolveMediaUrl, resolveSession: session.resolveSession }),
    );

    await handle(reqStub("/media/avatars/user-1/abc.orig.webp", "GET", session.headers), res);

    // The `.orig` infix is what marks the owner's untouched file; its redirect
    // is never cached, matching the post-media rule, so a shared browser
    // cannot hand the owner's private object to a later viewer.
    expect(resolveMediaUrl).toHaveBeenCalledWith("avatars/user-1/abc.orig.webp", "viewer-1");
    expect(calls.statusCode).toBe(302);
    expect(calls.headers).toMatchObject({ "Cache-Control": "private, no-store" });
  });

  it("fails post media closed when the session store cannot establish a viewer", async () => {
    const { res, calls } = resStub();
    const resolveMediaUrl = vi.fn();
    const handle = createRequestHandler(
      deps({
        resolveMediaUrl,
        resolveSession: vi.fn().mockResolvedValue({ kind: "unavailable" }),
      }),
    );

    await handle(
      reqStub("/media/posts/author-1/post-1/attachment-1.png", "GET", {
        cookie: "better-auth.session_token=live",
      }),
      res,
    );

    expect(resolveMediaUrl).not.toHaveBeenCalled();
    expect(calls.statusCode).toBe(503);
    expect(calls.headers).toMatchObject({ "Cache-Control": "no-store" });
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
    const session = signedIn();
    const handle = createRequestHandler(deps({ resolveSession: session.resolveSession }));

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
    expect(JSON.parse(calls.body)).toEqual({
      error: "Internal Server Error",
      // The requestId rides the error body so the user (or their support
      // ticket) can cite the exact request that failed.
      requestId: calls.headersSet["x-request-id"],
    });
  });

  it("gives every request an x-request-id before any routing branch runs", async () => {
    // The identity is generated at the top of the tree, so every response —
    // health, auth, rpc, media, page, 404 — carries the same id its log
    // lines and the access log do. Asserted here on the health path, which
    // is the earliest branch in the tree.
    const { res, calls } = resStub();
    const handle = createRequestHandler(deps());

    await handle(reqStub("/health"), res);

    expect(calls.headersSet["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("notifies the injected observer of an unhandled request error", async () => {
    const { res, calls } = resStub();
    const observeError = vi.fn().mockReturnValue({ action: "continue" });
    const boom = new Error("boom");
    const handle = createRequestHandler(
      deps({ handleRpc: vi.fn().mockRejectedValue(boom), observeError }),
    );

    await handle(reqStub("/rpc/post.create?token=secret", "POST"), res);

    expect(observeError).toHaveBeenCalledOnce();
    expect(observeError).toHaveBeenCalledWith({
      source: "request",
      error: boom,
      requestId: calls.headersSet["x-request-id"],
      method: "POST",
      path: "/rpc/post.create",
    });
  });

  it("destroys the socket instead of double-writing when headers are already sent", async () => {
    // A handler that starts a response and THEN throws — the safety net must
    // not attempt a second writeHead/end on an already-committed response.
    const { res, isDestroyed } = resStub();
    const handle = createRequestHandler(
      deps({
        handleRpc: vi.fn().mockImplementation((_req: IncomingMessage, r: RequestResponse) => {
          r.writeHead(200, { "Content-Type": "application/json" });
          throw new Error("boom after headers sent");
        }),
      }),
    );

    await handle(reqStub("/rpc/post.create", "POST"), res);

    expect(isDestroyed()).toBe(true);
  });
});
