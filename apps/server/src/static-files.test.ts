import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { PassThrough } from "node:stream";
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { createStaticFileHandler, noStaticFiles, type StaticResponse } from "./static-files.js";

/**
 * A real directory laid out like a Vite build, because the whole point of this
 * module is what it does with the filesystem — stubbing `fs` would test the
 * stub. Small enough to build in a temp dir per run.
 */
let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "mytuums-static-"));
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(path.join(root, "assets", "index-abc123.js"), "console.log(1)");
  // A realistically-sized chunk, for the brotli-quality test: on a 13-byte
  // file every brotli quality emits the same bytes, so the fixture must be
  // big enough for quality to matter (q=4 vs q=11 diverge from a few KB).
  writeFileSync(
    path.join(root, "assets", "chunk-big.js"),
    `export const v = ${JSON.stringify("x".repeat(3000))};\n`,
  );
  writeFileSync(path.join(root, "mytuums.svg"), "<svg/>");
  writeFileSync(path.join(root, "manifest.webmanifest"), '{"name":"MyTuums"}');
  writeFileSync(path.join(root, "service-worker.js"), "self.addEventListener('fetch', () => {})");
});

interface StaticResponseRecord {
  statusCode: number;
  headers: OutgoingHttpHeaders;
}

/** Captures status, headers and the piped body. */
function resStub() {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(chunk));

  const calls: StaticResponseRecord = { statusCode: 0, headers: {} };
  // Only `writeHead` is added — a PassThrough already provides `end`, `pipe`
  // and `destroy`, and overriding `destroy` with one that calls `sink.destroy()`
  // makes it call itself.
  const res = Object.assign(sink, {
    writeHead(status: number, headers?: OutgoingHttpHeaders) {
      calls.statusCode = status;
      calls.headers = headers ?? {};
      return res;
    },
  });

  return {
    res: res satisfies StaticResponse,
    calls,
    body: () => Buffer.concat(chunks).toString(),
    // Raw bytes, for the compression tests: `body()` runs the bytes through
    // `toString()`, which is right for text fixtures but corrupts a gzip or
    // brotli body irreversibly (invalid UTF-8 sequences become U+FFFD).
    bodyBuffer: () => Buffer.concat(chunks),
  };
}

const req = (
  url: string,
  method = "GET",
  accept = "text/html",
  extraHeaders: Record<string, string> = {},
): IncomingMessage =>
  // SAFETY: Static-file routing reads only url, method, and headers from the request fixture.
  ({ url, method, headers: { accept, ...extraHeaders } }) as IncomingMessage;

describe("noStaticFiles", () => {
  it("never serves — the dev configuration, where Vite owns the app", async () => {
    await expect(noStaticFiles(req("/"), resStub().res)).resolves.toEqual({ served: false });
  });
});

describe("createStaticFileHandler", () => {
  it("serves a real file with its content type", async () => {
    const { res, calls, body } = resStub();
    const serve = createStaticFileHandler(root);

    await expect(serve(req("/mytuums.svg"), res)).resolves.toEqual({ served: true });
    expect(calls.statusCode).toBe(200);
    expect(calls.headers["Content-Type"]).toBe("image/svg+xml");
    expect(body()).toBe("<svg/>");
  });

  it("caches fingerprinted assets forever and index.html never", async () => {
    // Vite content-hashes everything under assets/, so those are immutable. If
    // index.html were cached the same way, a deploy would leave browsers
    // holding an index pointing at assets that no longer exist.
    const asset = resStub();
    await createStaticFileHandler(root)(req("/assets/index-abc123.js"), asset.res);
    expect(asset.calls.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");

    const index = resStub();
    await createStaticFileHandler(root)(req("/index.html"), index.res);
    expect(index.calls.headers["Cache-Control"]).toBe("no-cache");
  });

  it("serves the manifest and service worker with revalidation-safe headers", async () => {
    const manifest = resStub();
    await createStaticFileHandler(root)(req("/manifest.webmanifest"), manifest.res);
    expect(manifest.calls.headers["Content-Type"]).toBe("application/manifest+json");
    expect(manifest.calls.headers["Cache-Control"]).toBe("no-cache");

    const worker = resStub();
    await createStaticFileHandler(root)(req("/service-worker.js"), worker.res);
    expect(worker.calls.headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(worker.calls.headers["Cache-Control"]).toBe("no-cache");
  });

  it("falls back to index.html for a client route, so a refresh works", async () => {
    const { res, calls, body } = resStub();

    await expect(createStaticFileHandler(root)(req("/settings/account"), res)).resolves.toEqual({
      served: true,
    });
    expect(calls.statusCode).toBe(200);
    expect(body()).toContain("id=root");
  });

  it("does NOT fall back for a missing asset — that must 404, not return HTML", async () => {
    // Returning index.html for a mistyped script URL makes the browser fail to
    // parse HTML as JavaScript, with an error pointing nowhere near the cause.
    const { res } = resStub();
    await expect(
      createStaticFileHandler(root)(req("/assets/index-gone.js", "GET", "*/*"), res),
    ).resolves.toEqual({ served: false });
  });

  it("falls back for an extension-less path regardless of Accept — curl and link unfurlers send */*", async () => {
    // The routing chain handles every JSON-shaped prefix (/rpc, /api/auth,
    // /media) before static files, so nothing API-like reaches here. Refusing
    // `Accept: */*` would make the deployed site 404 for anything that is not
    // a browser.
    const { res, calls, body } = resStub();
    await expect(
      createStaticFileHandler(root)(req("/some/client/route", "GET", "*/*"), res),
    ).resolves.toEqual({ served: true });
    expect(calls.statusCode).toBe(200);
    expect(body()).toContain("id=root");
  });

  it("refuses an encoded traversal, which the URL parser does not collapse", async () => {
    // `%2f` survives `new URL(...).pathname`, so the escape only appears after
    // `decodeURIComponent`. This is the case a check written against the raw
    // URL misses, and why the guard is a `path.resolve` prefix test instead.
    const { res } = resStub();
    await expect(
      createStaticFileHandler(root)(req("/..%2f..%2fetc%2fpasswd"), res),
    ).resolves.toEqual({ served: false });
  });

  it("cannot read outside the root via a plain ../ either", async () => {
    // Here the URL parser has already normalised `/../../etc/passwd` down to
    // `/etc/passwd` before this module sees it, so nothing escapes: it resolves
    // to <root>/etc/passwd, which does not exist. What comes back is the SPA
    // fallback for an unknown route — never the host's /etc/passwd.
    const { res, body, calls } = resStub();
    await expect(createStaticFileHandler(root)(req("/../../etc/passwd"), res)).resolves.toEqual({
      served: true,
    });

    expect(calls.statusCode).toBe(200);
    expect(body()).toContain("id=root");
    expect(body()).not.toContain("root:");
  });

  it("ignores write verbs", async () => {
    const { res } = resStub();
    await expect(createStaticFileHandler(root)(req("/mytuums.svg", "POST"), res)).resolves.toEqual({
      served: false,
    });
  });

  it("serves nothing when the directory does not exist", async () => {
    const serve = createStaticFileHandler(path.join(root, "does-not-exist"));
    await expect(serve(req("/"), resStub().res)).resolves.toEqual({ served: false });
  });
});

describe("compression", () => {
  it("serves gzip when the client accepts it, plus a Vary header", async () => {
    const { res, calls, bodyBuffer } = resStub();

    await expect(
      createStaticFileHandler(root)(
        req("/assets/index-abc123.js", "GET", "*/*", { "accept-encoding": "gzip" }),
        res,
      ),
    ).resolves.toEqual({ served: true });

    expect(calls.headers["Content-Encoding"]).toBe("gzip");
    expect(calls.headers["Vary"]).toBe("Accept-Encoding");
    expect(gunzipSync(bodyBuffer()).toString()).toBe("console.log(1)");
  });

  it("prefers brotli over gzip when both are offered", async () => {
    const { res, calls, bodyBuffer } = resStub();

    await expect(
      createStaticFileHandler(root)(
        req("/assets/index-abc123.js", "GET", "*/*", { "accept-encoding": "gzip, br" }),
        res,
      ),
    ).resolves.toEqual({ served: true });

    expect(calls.headers["Content-Encoding"]).toBe("br");
    expect(brotliDecompressSync(bodyBuffer()).toString()).toBe("console.log(1)");
  });

  it("compresses brotli at the explicit dynamic quality, not the zlib default (11)", async () => {
    // The zlib default brotli quality (11) is designed for build-time assets;
    // this stream runs per request on bundles a cold load pays for once, and
    // q=11 blocks the event loop for ~10 ms for a few percent of bytes
    // (issue #54). Asserted byte-for-byte against a q=4 compression of the
    // same file, which differs from the q=11 bytes at this size.
    const { res, calls, bodyBuffer } = resStub();
    const fixture = Buffer.from(`export const v = ${JSON.stringify("x".repeat(3000))};\n`);

    await expect(
      createStaticFileHandler(root)(
        req("/assets/chunk-big.js", "GET", "*/*", { "accept-encoding": "gzip, br" }),
        res,
      ),
    ).resolves.toEqual({ served: true });

    expect(calls.headers["Content-Encoding"]).toBe("br");
    expect(bodyBuffer()).toEqual(
      brotliCompressSync(fixture, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      }),
    );
  });

  it("honours an explicit q=0 refusal rather than compressing anyway", async () => {
    const { res, calls, body } = resStub();

    await expect(
      createStaticFileHandler(root)(
        req("/assets/index-abc123.js", "GET", "*/*", { "accept-encoding": "gzip;q=0, br;q=0" }),
        res,
      ),
    ).resolves.toEqual({ served: true });

    expect(calls.headers["Content-Encoding"]).toBeUndefined();
    expect(body()).toBe("console.log(1)");
  });
});
