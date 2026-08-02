import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
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

function reqStub(url: string, method = "GET"): IncomingMessage {
  return { url, method } as unknown as IncomingMessage;
}

function deps(overrides: Partial<RequestHandlerDeps> = {}): RequestHandlerDeps {
  return {
    pingDb: vi.fn().mockResolvedValue(undefined),
    authNodeHandler: vi.fn().mockResolvedValue(undefined),
    handleRpc: vi.fn().mockResolvedValue({ matched: true }),
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
