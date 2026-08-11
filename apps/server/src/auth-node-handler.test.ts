import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createAuthNodeHandler } from "./auth-node-handler.js";

function requestStub(
  method: string,
  headers: Record<string, string> = {},
): PassThrough & IncomingMessage {
  const req = new PassThrough() as PassThrough & Partial<IncomingMessage>;
  Object.assign(req, {
    method,
    url: "/api/auth/sign-in/email",
    headers: { host: "localhost", ...headers },
    socket: { encrypted: false },
  });
  return req as PassThrough & IncomingMessage;
}

function responseStub() {
  const emitter = new EventEmitter();
  const headers = new Map<string, string | string[]>();
  const chunks: Buffer[] = [];
  let statusCode: number | undefined;
  let headersSent = false;
  let destroyed = false;

  const res = Object.assign(emitter, {
    get headersSent() {
      return headersSent;
    },
    get statusCode() {
      return statusCode;
    },
    get destroyed() {
      return destroyed;
    },
    setHeader(name: string, value: string | string[]) {
      headers.set(name.toLowerCase(), value);
      return res;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    getHeaderNames() {
      return [...headers.keys()];
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase());
    },
    writeHead(status: number, extra?: Record<string, string>) {
      statusCode = status;
      headersSent = true;
      for (const [name, value] of Object.entries(extra ?? {})) headers.set(name.toLowerCase(), value);
      return res;
    },
    write(chunk: Uint8Array | string) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk?: Uint8Array | string) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      return res;
    },
    destroy() {
      destroyed = true;
      return res;
    },
  });

  return {
    res: res as unknown as ServerResponse,
    status: () => statusCode,
    header: (name: string) => headers.get(name.toLowerCase()),
    body: () => Buffer.concat(chunks).toString(),
    isDestroyed: () => destroyed,
  };
}

describe("createAuthNodeHandler", () => {
  it("returns 413 before invoking Better Auth for an oversized declared body", async () => {
    const handler = vi.fn<(request: Request) => Promise<Response>>();
    const request = requestStub("POST", {
      "content-type": "application/json",
      "content-length": "9",
    });
    const response = responseStub();
    const serveAuth = createAuthNodeHandler(handler, 8);

    const result = serveAuth(request, response.res);
    request.end();
    await result;

    expect(response.status()).toBe(413);
    expect(response.body()).toBe("Payload too large");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 413 when a chunked body crosses the limit while streaming", async () => {
    const handler = vi.fn<(request: Request) => Promise<Response>>();
    const request = requestStub("POST", {
      "content-type": "application/json",
      "transfer-encoding": "chunked",
    });
    const response = responseStub();
    const serveAuth = createAuthNodeHandler(handler, 8);

    const result = serveAuth(request, response.res);
    request.write("1234");
    request.write("56789");
    request.end();
    await result;

    expect(response.status()).toBe(413);
    expect(response.body()).toBe("Payload too large");
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes a small JSON body through and preserves Better Auth response headers", async () => {
    const handler = vi.fn<(request: Request) => Promise<Response>>(async (request) => {
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual({ email: "alice@example.com" });
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "set-cookie": "session=abc; Path=/; HttpOnly",
        },
      });
    });
    const body = JSON.stringify({ email: "alice@example.com" });
    const request = requestStub("POST", {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });
    const response = responseStub();
    const serveAuth = createAuthNodeHandler(handler, 8 * 1024);

    const result = serveAuth(request, response.res);
    request.end(body);
    await result;

    expect(response.status()).toBe(201);
    expect(response.header("cache-control")).toBe("no-store");
    expect(response.header("set-cookie")).toEqual(["session=abc; Path=/; HttpOnly"]);
    expect(JSON.parse(response.body())).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps GET and HEAD requests bodyless while using the normal adapter response path", async () => {
    const handler = vi.fn<(request: Request) => Promise<Response>>((request) => {
      expect(request.body).toBeNull();
      return Promise.resolve(
        new Response(null, { status: 204, headers: { "cache-control": "no-store" } }),
      );
    });
    const serveAuth = createAuthNodeHandler(handler, 8);

    for (const method of ["GET", "HEAD"] as const) {
      const request = requestStub(method);
      request.end();
      const response = responseStub();

      await serveAuth(request, response.res);

      expect(response.status()).toBe(204);
      expect(response.header("cache-control")).toBe("no-store");
    }
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
