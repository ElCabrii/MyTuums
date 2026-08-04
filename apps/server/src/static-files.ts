import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import { createBrotliCompress, createGzip } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
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
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

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

export type StaticFileHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<{ served: boolean }>;

/** Never serves anything. What a dev server (and a test) gets. */
export const noStaticFiles: StaticFileHandler = () => Promise.resolve({ served: false });

export function createStaticFileHandler(rootDir: string): StaticFileHandler {
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

    if (file) {
      await send(req, res, req.method === "HEAD", file, cacheHeaderFor(root, file));
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

    await send(req, res, req.method === "HEAD", indexPath, "no-cache");
    return { served: true };
  };
}

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
    pathname = decodeURIComponent(new URL(rawUrl, "http://static.invalid").pathname);
  } catch {
    return null;
  }

  const resolved = path.resolve(root, `.${pathname}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
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
 */
function cacheHeaderFor(root: string, file: string): string {
  const relative = path.relative(root, file);
  return relative.startsWith(`assets${path.sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  headOnly: boolean,
  file: string,
  cacheControl: string,
): Promise<void> {
  const encoding = preferredEncoding(req.headers["accept-encoding"], file);

  const headers: Record<string, string> = {
    "Content-Type":
      CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
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

    const compressor =
      encoding === "br" ? createBrotliCompress() : encoding === "gzip" ? createGzip() : null;
    if (compressor) compressor.on("error", abort);

    // `stream.pipe(compressor)` narrows to `Gzip`, so a ternary here would
    // infer `ReadStream | Gzip` — a union whose `.on` overloads do not unify
    // (TS2349). Annotate the common readable surface instead.
    let last: Readable;
    if (compressor) last = stream.pipe(compressor);
    else last = stream;
    last.on("error", abort);
    last.on("end", resolve);
    last.pipe(res);
  });
}
