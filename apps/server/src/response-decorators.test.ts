import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { brotliCompressSync, constants, gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decorateResponse, type ResponseDecoratorOptions } from "./response-decorators.js";

/**
 * The decorator is exercised through a real HTTP server and a raw `node:http`
 * client — deliberately not `fetch`, whose undici implementation transparently
 * decompresses gzip/brotli responses, which would make "did the server
 * compress?" unobservable. Raw bytes in, raw bytes out.
 */

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function rawRequest(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** Boots a server whose responses all flow through `decorateResponse`, then runs `run`. */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (
    raw: (path: string, init?: Parameters<typeof rawRequest>[2]) => Promise<RawResponse>,
  ) => Promise<void>,
  decoratorOptions: ResponseDecoratorOptions = {},
): Promise<void> {
  const server = createServer((req, res) => {
    decorateResponse(req, res, decoratorOptions);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = z.object({ port: z.number() }).parse(server.address());
    await run((path, init) => rawRequest(address.port, path, init));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function expectSecurityHeaders(headers: RawResponse["headers"]): void {
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expectContentSecurityPolicy(headers);
}

/**
 * Asserts the CSP header is present and every directive this policy is
 * derived from (see `response-decorators.ts`'s doc comment) actually shows up
 * — a well-formed, single-value header covering the directives the app's own
 * code requires, not just "some string got sent".
 */
function expectContentSecurityPolicy(headers: RawResponse["headers"]): void {
  const csp = headers["content-security-policy"];
  // A single string value (never an array) proves `applyDefaults` never sets
  // this header twice — Node would otherwise fold duplicate values.
  expect(Array.isArray(csp)).toBe(false);
  if (csp === undefined || Array.isArray(csp)) {
    throw new Error("expected one Content-Security-Policy value");
  }
  const policy = csp;

  const directives = policy.split("; ");
  expect(directives).toContain("default-src 'self'");
  expect(directives).toContain("base-uri 'self'");
  expect(directives).toContain("object-src 'none'");
  expect(directives).toContain("img-src 'self' https: blob:");
  expect(directives).toContain("font-src 'self'");
  expect(directives).toContain("style-src 'self' 'unsafe-inline' https://accounts.google.com");
  expect(directives).toContain("connect-src 'self' https://accounts.google.com");
  expect(directives).toContain("worker-src 'self'");
  expect(directives).toContain("frame-src https://accounts.google.com");
  expect(directives).toContain("form-action 'self'");
  expect(directives).toContain("frame-ancestors 'none'");

  // script-src carries a hash whose exact value is an implementation detail
  // (it moves if the shared onload-handler constant ever changes) — assert
  // the fixed parts and the shape of the hash-source rather than a literal.
  const scriptSrc = directives.find((d) => d.startsWith("script-src "));
  expect(scriptSrc).toBeDefined();
  expect(scriptSrc).toContain("'self'");
  expect(scriptSrc).toContain("https://accounts.google.com");
  expect(scriptSrc).toContain("'unsafe-hashes'");
  expect(scriptSrc).toMatch(/'sha256-[\w+/]+=*'/);
  expect(scriptSrc).not.toContain("googletagmanager.com");
  expect(policy).not.toContain("google-analytics.com");

  // Never report-only — issue #61 requires this enforced, not observed.
  expect(headers["content-security-policy-report-only"]).toBeUndefined();
}

const BIG_JSON = JSON.stringify({ payload: "x".repeat(5000) });
const SMALL_JSON = JSON.stringify({ ok: true });

describe("decorateResponse", () => {
  it("adds the five security headers to a plain JSON 200", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(SMALL_JSON);
      },
      async (raw) => {
        const r = await raw("/");
        expect(r.status).toBe(200);
        expectSecurityHeaders(r.headers);
        expect(r.body.toString()).toBe(SMALL_JSON);
      },
    );
  });

  it("adds GA4 sources only when configured and never on the branding host", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("ok");
      },
      async (raw) => {
        const app = await raw("/", { headers: { Host: "mytuums.com" } });
        const appPolicy = String(app.headers["content-security-policy"]);
        expect(appPolicy).toContain("https://www.googletagmanager.com");
        expect(appPolicy).toContain("https://*.google-analytics.com");
        expect(appPolicy).toContain("https://*.analytics.google.com");

        const branding = await raw("/", { headers: { Host: "about.mytuums.com" } });
        const brandingPolicy = String(branding.headers["content-security-policy"]);
        expect(brandingPolicy).not.toContain("googletagmanager.com");
        expect(brandingPolicy).not.toContain("google-analytics.com");
      },
      { googleAnalytics: true },
    );
  });

  it("labels a small JSON body with Content-Length when compression is skipped", async () => {
    // Browsers always send `accept-encoding: gzip`, so small responses
    // (me/like/follow) are compression candidates that end up uncompressed —
    // they must still travel with a size label instead of chunked.
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(SMALL_JSON);
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.headers["content-encoding"]).toBeUndefined();
        expect(r.headers["transfer-encoding"]).toBeUndefined();
        expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(SMALL_JSON));
        expect(r.body.toString()).toBe(SMALL_JSON);
      },
    );
  });

  it("adds them to a 302 too, without clobbering the handler's Location", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(302, { Location: "/media/some-key", "Cache-Control": "private" });
        res.end();
      },
      async (raw) => {
        const r = await raw("/");
        expect(r.status).toBe(302);
        expectSecurityHeaders(r.headers);
        expect(r.headers.location).toBe("/media/some-key");
        expect(r.headers["cache-control"]).toBe("private");
      },
    );
  });

  it("gzip-compresses a large JSON body when the client accepts gzip", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(BIG_JSON);
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.headers["content-encoding"]).toBe("gzip");
        expect(r.headers.vary).toBe("Accept-Encoding");
        expect(gunzipSync(r.body).toString()).toBe(BIG_JSON);
      },
    );
  });

  it("compresses brotli at the explicit dynamic quality, not the zlib default (11)", async () => {
    // The zlib default brotli quality (11) is designed for build-time assets;
    // on the per-request path it blocks the event loop for ~10 ms per feed
    // page for a few percent of bytes (issue #54). The decorator must pass
    // the per-request quality explicitly — asserted byte-for-byte against a
    // q=4 compression of the same body, which differs from the q=11 bytes.
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(BIG_JSON);
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip, br" } });
        expect(r.headers["content-encoding"]).toBe("br");
        expect(r.body).toEqual(
          brotliCompressSync(Buffer.from(BIG_JSON), {
            params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
          }),
        );
      },
    );
  });

  it("leaves small JSON bodies identity — the size threshold is the point", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(SMALL_JSON);
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.headers["content-encoding"]).toBeUndefined();
        expect(r.body.toString()).toBe(SMALL_JSON);
      },
    );
  });

  it("never compresses a redirect", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(302, { Location: "/media/some-key" });
        res.end();
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.status).toBe(302);
        expect(r.headers["content-encoding"]).toBeUndefined();
        expect(r.body.length).toBe(0);
      },
    );
  });

  it("passes through a response that already sets Content-Encoding — no double compression", async () => {
    // Static files set their own encoding; the decorator must not compress a
    // body that is already gzip bytes.
    await withServer(
      (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        });
        res.end(gzipSync(Buffer.from(BIG_JSON)));
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.headers["content-encoding"]).toBe("gzip");
        // If the decorator had compressed again, this gunzip would throw.
        expect(gunzipSync(r.body).toString()).toBe(BIG_JSON);
      },
    );
  });

  it("buffers a write-then-end body and compresses it as one unit", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"parts":["');
        res.write(BIG_JSON);
        res.write('"]}');
        res.end();
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.headers["content-encoding"]).toBe("gzip");
        expect(gunzipSync(r.body).toString()).toBe(`{"parts":["${BIG_JSON}"]}`);
      },
    );
  });

  it("never compresses a HEAD response", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(BIG_JSON);
      },
      async (raw) => {
        const r = await raw("/", {
          method: "HEAD",
          headers: { "accept-encoding": "gzip" },
        });
        expect(r.headers["content-encoding"]).toBeUndefined();
        expect(r.body.length).toBe(0);
      },
    );
  });

  it("invokes the end() callback with a compressed response", async () => {
    let ended = false;
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(BIG_JSON, () => {
          ended = true;
        });
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.headers["content-encoding"]).toBe("gzip");
        expect(gunzipSync(r.body).toString()).toBe(BIG_JSON);
        expect(ended).toBe(true);
      },
    );
  });

  it("adds the security headers when end() is called without writeHead", async () => {
    await withServer(
      (_req, res) => {
        res.end(SMALL_JSON);
      },
      async (raw) => {
        const r = await raw("/");
        expectSecurityHeaders(r.headers);
        expect(r.body.toString()).toBe(SMALL_JSON);
      },
    );
  });

  it("merges a Vary passed in the writeHead args instead of clobbering it", async () => {
    // oRPC's CORS plugin passes `Vary: Origin` in the writeHead headers
    // argument; Node re-applies those headers on top of setHeader state, so
    // the decorator must strip the args' Vary and re-emit the merged value.
    await withServer(
      (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          Vary: "Origin",
        });
        res.end(BIG_JSON);
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.headers["content-encoding"]).toBe("gzip");
        expect(r.headers.vary).toBe("Origin, Accept-Encoding");
      },
    );
  });

  it("drops a stale Content-Length from the writeHead args when compressing", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(BIG_JSON),
        });
        res.end(BIG_JSON);
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.headers["content-encoding"]).toBe("gzip");
        // The advertised length must be the compressed body's, never the
        // uncompressed size the handler computed — a stale length would
        // truncate or hang the client.
        expect(Number(r.headers["content-length"])).toBe(r.body.length);
        expect(r.body.length).not.toBe(Buffer.byteLength(BIG_JSON));
        expect(gunzipSync(r.body).toString()).toBe(BIG_JSON);
      },
    );
  });

  it("replaces a stashed writeHead — request-handler's catch path gets a clean 500", async () => {
    // With the real writeHead deferred, a second call replaces the first
    // (request-handler calls writeHead(500) after writeHead(200) when a
    // handler fails mid-response). It must not throw into the process.
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(BIG_JSON);
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.status).toBe(500);
        expect(r.headers["content-encoding"]).toBe("gzip");
        expect(gunzipSync(r.body).toString()).toBe(BIG_JSON);
      },
    );
  });

  it("still compresses a body sent after flushHeaders()", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.flushHeaders();
        res.write(BIG_JSON);
        res.end();
      },
      async (raw) => {
        const r = await raw("/", { headers: { "accept-encoding": "gzip" } });
        expect(r.status).toBe(200);
        expect(r.headers["content-encoding"]).toBe("gzip");
        expect(gunzipSync(r.body).toString()).toBe(BIG_JSON);
      },
    );
  });

  // The inner-wins mechanism itself (`applyDefaults`'s `hasHeader` guard)
  // predates the CSP header and is not re-tested here; this only pins that
  // the mechanism also covers the new header name, so a future refactor that
  // special-cases CSP (e.g. to always enforce it) cannot do so silently.
  it("lets a handler override the Content-Security-Policy — inner wins", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Security-Policy": "default-src 'none'",
        });
        res.end(SMALL_JSON);
      },
      async (raw) => {
        const r = await raw("/");
        expect(r.headers["content-security-policy"]).toBe("default-src 'none'");
      },
    );
  });
});
