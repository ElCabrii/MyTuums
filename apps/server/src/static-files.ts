import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import {
  brotliCompressSync,
  constants,
  createBrotliCompress,
  createGzip,
  gzipSync,
} from "node:zlib";
import type { BrotliCompress, Gzip } from "node:zlib";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { bestEncoding, type Compression } from "./compression.js";

/**
 * Serving the built web app from the same origin as the API.
 *
 * Not a convenience: `apps/web/src/lib/orpc.ts` resolves `/rpc` against
 * `window.location.origin`, and uploaded images are stored as relative
 * `/media/<key>` paths for the same reason. Both assume one origin, so a
 * deployment that put the SPA on a different host than the API would break RPC
 * calls and every avatar at once. One service serving both is what makes that
 * assumption true in production, the way the Vite proxy makes it true in dev.
 *
 * Disabled unless `WEB_DIST` points at a real directory, so `pnpm dev` — where
 * Vite serves the app and proxies to this server — is completely unaffected.
 */

/**
 * Content types for what a Vite build actually emits. Deliberately a small
 * allowlist with a conservative fallback rather than a `mime` dependency: an
 * unknown extension served as `application/octet-stream` downloads instead of
 * executing, which is the safe direction to be wrong in.
 */
const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
  [".map", "application/json; charset=utf-8"],
  // For the crawlers reading public/robots.txt and public/sitemap.xml.
  // Without an entry the allowlist's octet-stream fallback would download
  // instead of render — harmless for a crawler, wrong for a human opening it.
  [".xml", "application/xml; charset=utf-8"],
]);

/**
 * File types worth compressing. Everything else — images, fonts — is already
 * compressed by its own format, and re-compressing costs CPU for nothing.
 */
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".css",
  ".json",
  ".svg",
  ".txt",
  ".webmanifest",
  ".map",
  ".xml",
]);

/**
 * The best compression this client accepts, or `null` for identity.
 *
 * The q-value parsing itself is in `compression.ts` (shared with the response
 * decorator, which compresses JSON bodies); here it is gated on the file
 * extension, because images and fonts are already compressed by their own
 * formats and re-compressing them costs CPU for nothing.
 *
 * This is the byte-level partner of the cache headers below: without
 * compression the immutable assets are downloaded raw, and on the slowest
 * connections the main chunk dwarfs every other cost on the page.
 */
function preferredEncoding(acceptEncoding: string | undefined, file: string): Compression {
  const ext = path.extname(file).toLowerCase();
  if (!COMPRESSIBLE_EXTENSIONS.has(ext)) return null;
  return bestEncoding(acceptEncoding);
}

/**
 * A handler that may serve a request itself; `{ served: false }` means "not a
 * static file" and falls through to the caller's 404.
 */
export interface StaticResponse extends NodeJS.WritableStream {
  writeHead(status: number, headers?: OutgoingHttpHeaders): this;
  destroy(error?: Error): this;
}

export type StaticFileHandler = (
  req: IncomingMessage,
  res: StaticResponse,
) => Promise<{ served: boolean }>;

/** Never serves anything. What a dev server (and a test) gets. */
export const noStaticFiles: StaticFileHandler = () => Promise.resolve({ served: false });

/**
 * Rewrites the SPA's `index.html` for one client route before it is served.
 *
 * The one production use is crawler-facing heads (0.4.0): the SPA emits
 * per-route `<title>`/description/canonical/Open Graph tags only after it
 * mounts, which a no-JS unfurler never sees, so the server substitutes the
 * `[data-app-fallback]` head block per route — see `./public-heads.ts`. The
 * replacement tags carry the same `data-app-fallback` attribute, so the SPA's
 * own mount effect (`__root.tsx`) still removes them and the route's live
 * head becomes the single owner.
 *
 * Only ever invoked with the request's pathname and the raw `index.html`
 * contents, for the direct `/index.html` hit and the SPA fallback alike —
 * the two must not diverge. An implementation that does not recognize the
 * path returns the input unchanged.
 */
export type IndexHtmlTransform = (pathname: string, html: string) => Promise<string>;

/**
 * Creates the static-file handler over a built SPA (`rootDir`): serves real
 * files with per-extension content types and compression, caches `assets/`
 * as immutable, and falls back to `index.html` for extension-less client
 * routes. The production half of the one-origin requirement — wired in
 * `index.ts` only when `WEB_DIST` is set (see the module header).
 */
export function createStaticFileHandler(
  rootDir: string,
  options: { transformIndexHtml?: IndexHtmlTransform } = {},
): StaticFileHandler {
  const root = path.resolve(rootDir);
  const indexPath = path.join(root, "index.html");

  return async function serveStatic(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") return { served: false };

    const requested = resolveWithinRoot(root, req.url ?? "/");
    // `null` means the path escaped the root — a traversal attempt. Treated as
    // "not a static file" rather than as a 403, so it falls through to the
    // caller's 404 and reveals nothing about the layout on disk.
    if (requested === null) return { served: false };

    const file = (await isFile(requested)) ? requested : null;

    if (file === indexPath && options.transformIndexHtml) {
      await serveTransformedIndex(req, res, options.transformIndexHtml, root, indexPath);
      return { served: true };
    }

    if (file) {
      await send(req, res, {
        headOnly: req.method === "HEAD",
        file,
        cacheControl: cacheHeaderFor(root, file),
      });
      return { served: true };
    }

    /**
     * The SPA fallback. Every client route (`/@alex`, `/settings/account`) is a
     * real URL someone can paste or refresh, and none of them exist on disk —
     * without this they would 404 and only in-app navigation would work.
     *
     * Guarded on it looking like a document request rather than a missing
     * asset: a mistyped `/assets/index-abc.js` must 404, not quietly return
     * HTML, which the browser would then fail to parse as JavaScript with an
     * error pointing nowhere near the cause.
     */
    if (!(await isFile(indexPath))) return { served: false };
    // The extension check is the actual protection. A mistyped `/assets/foo.js`
    // must 404, not return HTML the browser then fails to parse as JavaScript —
    // but an *extension-less* path is either a client route or a brand asset
    // that exists, and every API prefix (`/rpc`, `/api/auth`, `/media`) is
    // handled earlier in the routing chain, so nothing JSON-shaped ever reaches
    // here. That is why the Accept header is deliberately NOT consulted: curl
    // and link unfurlers send `*/*`, and refusing them the SPA would make the
    // deployed site look broken to anything that isn't a browser.
    if (path.extname(requested) !== "") return { served: false };

    if (options.transformIndexHtml) {
      // Through the same helper as a direct `/index.html` hit: the SPA fallback
      // serves the identical bytes, so it must carry the identical no-transform
      // guarantee.
      await serveTransformedIndex(req, res, options.transformIndexHtml, root, indexPath);
      return { served: true };
    }

    await send(req, res, {
      headOnly: req.method === "HEAD",
      file: indexPath,
      // Through the same helper as a direct `/index.html` hit: the SPA fallback
      // serves the identical bytes, so it must carry the identical no-transform
      // guarantee.
      cacheControl: cacheHeaderFor(root, indexPath),
    });
    return { served: true };
  };
}

/** The one path both index.html serving branches share: transform, then buffer-send. */
async function serveTransformedIndex(
  req: IncomingMessage,
  res: StaticResponse,
  transformIndexHtml: IndexHtmlTransform,
  root: string,
  indexPath: string,
): Promise<void> {
  const html = await transformIndexHtml(
    pathnameOf(req.url ?? "/"),
    await readFile(indexPath, "utf8"),
  );
  sendBuffer(req, res, {
    headOnly: req.method === "HEAD",
    body: Buffer.from(html),
    cacheControl: cacheHeaderFor(root, indexPath),
  });
}

/** The decoded pathname of a request, or "/" — what a head transform keys on. */
function pathnameOf(rawUrl: string): string {
  try {
    return decodeURIComponent(new URL(rawUrl, URL_PARSE_BASE).pathname);
  } catch {
    return "/";
  }
}

/**
 * The base URL the WHATWG parser needs to resolve a request path. The host
 * is a sentinel — the server only ever sees path names, never a request for
 * this host — so it contributes nothing but parsing rules (path
 * normalisation, percent-encoding and query stripping). Deliberately a named
 * constant, not an env var: it is a parser detail, not configuration.
 */
const URL_PARSE_BASE = "http://static.invalid";

/**
 * The absolute path a request maps to, or `null` if it escapes `root`.
 *
 * `path.resolve` collapses `..` before the prefix check, so the check is on the
 * resolved path rather than on the raw URL — testing the URL for `..` is the
 * version of this that percent-encoding defeats.
 */
function resolveWithinRoot(root: string, rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, URL_PARSE_BASE).pathname);
  } catch {
    return null;
  }

  const resolved = path.resolve(root, `.${pathname}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    // The parens are load-bearing, not stylistic: `await stat(candidate)`
    // yields the Stats, and `.isFile()` is called on *that*. Without them,
    // `await stat(candidate).isFile()` would call `.isFile()` on the Promise
    // itself — a TypeError the catch below would swallow into a silent 404
    // for every existing file.
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Vite fingerprints everything under `assets/` with a content hash, so those
 * files are immutable and can be cached forever. Anything else — `index.html`
 * above all — must be revalidated, or a deploy leaves browsers holding an
 * index that references assets that no longer exist.
 *
 * HTML additionally carries `no-transform`, which is a **security control, not
 * a cache hint**. The Content-Security-Policy in `./response-decorators.ts`
 * allows inline scripts only by hash, so it can only ever be correct for the
 * exact bytes this server sent. An intermediary that rewrites the document —
 * concretely, Cloudflare's JavaScript Detections, which injects an inline
 * `<script>` carrying the per-request ray ID that no static hash can cover —
 * produces a document its own policy forbids, and every page load logs a CSP
 * violation. `no-transform` is the standard way to say the body is byte-exact
 * and must be delivered unmodified, and Cloudflare documents it as suppressing
 * that injection. Asserting it here keeps the guarantee in code that ships with
 * the policy it protects, instead of in a dashboard toggle that has silently
 * regressed before (see docs/security.md).
 *
 * The cost is edge compression on HTML, which this server already does itself
 * (`COMPRESSIBLE_EXTENSIONS` above includes `.html`), so nothing is lost.
 */
function cacheHeaderFor(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (relative.startsWith(`assets${path.sep}`)) return "public, max-age=31536000, immutable";
  return path.extname(file).toLowerCase() === ".html" ? "no-cache, no-transform" : "no-cache";
}

function send(
  req: IncomingMessage,
  res: StaticResponse,
  options: { headOnly: boolean; file: string; cacheControl: string },
): Promise<void> {
  const { headOnly, file, cacheControl } = options;
  const encoding = preferredEncoding(req.headers["accept-encoding"], file);

  interface StaticResponseHeaders {
    [header: string]: string | undefined;
    "Content-Type": string;
    "Cache-Control": string;
    "Content-Encoding"?: string;
    Vary?: string;
  }
  const headers: StaticResponseHeaders = {
    "Content-Type":
      CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
    "Cache-Control": cacheControl,
  };
  if (encoding) {
    headers["Content-Encoding"] = encoding;
    // The body now depends on a request header. Without this, a shared cache
    // (the Railway edge in front of the deployed server) could hand a
    // compressed body to a client that asked for identity, or vice versa.
    headers["Vary"] = "Accept-Encoding";
  }

  res.writeHead(200, headers);

  if (headOnly) {
    // HEAD must advertise the same Content-Encoding as the matching GET, even
    // though there is no body.
    res.end();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const abort = () => {
      // The file existed when it was stat'd and does not now (or zlib failed
      // mid-stream). Nothing useful can be written — headers are already sent
      // — so drop the socket rather than emit a truncated body the browser
      // would treat as complete.
      res.destroy();
      resolve();
    };
    const stream = createReadStream(file);
    stream.on("error", abort);

    let compressor: BrotliCompress | Gzip | null = null;
    if (encoding === "br") {
      // Brotli quality is set explicitly, never inherited: the zlib default
      // (11) is for assets compressed once at build time, but this stream runs
      // per request on a ~300 KB bundle. The output is immutable-cached so
      // repeat hits are free, yet a cold load still pays q=11's ~10 ms of
      // blocked event loop for a few percent of bytes (issue #54) — quality 4
      // is the dynamic-content range.
      compressor = createBrotliCompress({
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      });
    } else if (encoding === "gzip") {
      compressor = createGzip();
    }

    // `stream.pipe(compressor)` narrows to `Gzip`, so a ternary here would
    // infer `ReadStream | Gzip` — a union whose `.on` overloads do not unify
    // (TS2349). Annotate the common readable surface instead.
    let last: Readable;
    if (compressor) last = stream.pipe(compressor);
    else last = stream;
    // `last` is the compressor when one exists and the stream itself when
    // not. `abort` is registered on `stream` above and here only when the
    // two differ, so each stream gets exactly one handler — previously the
    // no-compressor path registered it twice on `stream` (and the compressed
    // path twice on the compressor), firing `abort` twice on a single error
    // (double `res.destroy()`, issue #59).
    if (last !== stream) last.on("error", abort);
    last.on("end", resolve);
    last.pipe(res);
  });
}

/**
 * The in-memory sibling of `send`, for bodies the server itself produced by
 * transforming `index.html` — same headers, same compression policy, same
 * Brotli-quality pinning, just over a Buffer instead of a file stream.
 *
 * Synchronous compression on purpose: the transformed HTML is small (~tens of
 * KiB) and per-request, and the streaming machinery above exists for
 * multi-hundred-KiB asset files, not for this.
 */
function sendBuffer(
  req: IncomingMessage,
  res: StaticResponse,
  options: { headOnly: boolean; body: Buffer; cacheControl: string },
): void {
  const { headOnly, body, cacheControl } = options;
  const encoding = bestEncoding(req.headers["accept-encoding"]);

  // The same named contract `send` above uses, minus the optional members
  // this path never varies on.
  interface BufferedHtmlHeaders {
    [header: string]: string | undefined;
    "Content-Type": string;
    "Cache-Control": string;
    "Content-Length": string;
  }
  const headers: BufferedHtmlHeaders = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": cacheControl,
    "Content-Length": "",
  };

  let payload = body;
  if (encoding === "br") {
    payload = brotliCompressSync(body, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    });
    headers["Content-Encoding"] = "br";
  } else if (encoding === "gzip") {
    payload = gzipSync(body);
    headers["Content-Encoding"] = "gzip";
  }
  if (encoding) headers["Vary"] = "Accept-Encoding";
  headers["Content-Length"] = String(payload.length);

  res.writeHead(200, headers);
  if (headOnly) res.end();
  else res.end(payload);
}
