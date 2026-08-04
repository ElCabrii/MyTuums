import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { bestEncoding, type Compression } from "./compression.js";

/**
 * One place to add per-response headers and compress JSON bodies, applied to
 * the `res` the `createServer` callback hands every handler (health, better-auth,
 * oRPC, media redirects, static files, 404/500). A single choke point means no
 * per-branch edits: `index.ts` wraps the response once and every writer sees
 * the decorated object.
 *
 * Two behaviours live here:
 *
 * 1. Security headers. Applied via `setHeader` guarded by `hasHeader`, so a
 *    handler that sets one itself keeps its value (inner wins). That guard is
 *    what makes this safe for better-auth, which writes headers through
 *    `setHeader` rather than the `writeHead` headers argument.
 *
 * 2. gzip/brotli for JSON responses. oRPC's own CompressionPlugin is NOT
 *    mounted (index.ts mounts only CORS + CSRF), so this is the only JSON
 *    compression in the app. Responses whose Content-Type is
 *    `application/json` and whose body reaches `MIN_COMPRESS_BODY_BYTES` get
 *    compressed when the client accepts it. The body is buffered to decide —
 *    which is fine, every JSON response here is a single bounded `end()`
 *    (feeds are the largest, a few hundred KB at most). Static files set
 *    their own Content-Encoding and are excluded by the "already has
 *    content-encoding" check, so nothing is ever double-compressed.
 *
 * Headers can only be mutated until `writeHead` sends the header block
 * (`ERR_HTTP_HEADERS_SENT` after), and `Content-Encoding`/`Content-Length`
 * depend on the body that has not arrived yet. So for compression candidates
 * the real `writeHead` is *deferred until `end`*, the standard on-headers
 * pattern. Every writer in this app calls `writeHead` then `end` (or a
 * `write` loop then `end`) synchronously or with bounded async work in
 * between, and none of them reads `headersSent` after `writeHead`, so the
 * deferral is invisible to them. Non-candidates flush immediately and behave
 * byte-for-byte like an undecorated response.
 */

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  // Browsers ignore HSTS received over plain HTTP, so this is inert on
  // localhost and the e2e suite, and effective once the Railway edge (which
  // terminates TLS) forwards it to a browser.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

/** Bodies smaller than this are sent identity — compressing them costs CPU for nothing. */
const MIN_COMPRESS_BODY_BYTES = 1024;

/** The callback shape `res.write(chunk, cb)` and `res.end(chunk, cb)` accept. */
type WriteCallback = (error?: Error | null) => void;

export function decorateResponse(req: IncomingMessage, res: ServerResponse): ServerResponse {
  const originalWriteHead = res.writeHead.bind(res);
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const originalFlushHeaders = res.flushHeaders.bind(res);

  let defaultsApplied = false;
  // The writeHead call being deferred for compression candidates.
  let stashed: { status: number; rest: unknown[] } | null = null;
  // True when this response would be compressed if the body is big enough.
  let candidate = false;
  let pendingEncoding: Compression = null;
  // Body bytes (and write callbacks) accumulated while the header block waits.
  let chunks: Buffer[] = [];
  let writeCallbacks: WriteCallback[] = [];
  let flushed = false;
  let compress = false;

  function applyDefaults(): void {
    if (defaultsApplied) return;
    defaultsApplied = true;
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      // Inner wins: a handler that sets one of these deliberately keeps its
      // value, for both the setHeader path (better-auth) and the writeHead
      // headers-argument path (everything else) — Node merges writeHead-arg
      // headers on top of the setHeader state.
      if (!res.hasHeader(name)) res.setHeader(name, value);
    }
  }

  /** The effective header view (setHeader state + writeHead args), lowercased. */
  function mergedHeaders(headersArg: OutgoingHttpHeaders | undefined): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [name, value] of Object.entries(res.getHeaders())) {
      if (value !== undefined) merged[name.toLowerCase()] = String(value);
    }
    if (headersArg) {
      for (const [name, value] of Object.entries(headersArg)) {
        if (value !== undefined) merged[name.toLowerCase()] = String(value);
      }
    }
    return merged;
  }

  /** Returns `rest` with the named headers removed from its headers object, if any. */
  function stripHeaders(rest: unknown[], names: string[]): unknown[] {
    // The headers object sits at index 0 (writeHead(status, headers)) or
    // index 1 (writeHead(status, reason, headers)).
    const index = rest.findIndex(
      (arg) => typeof arg === "object" && arg !== null && !Array.isArray(arg),
    );
    if (index === -1) return rest;
    const headers = { ...(rest[index] as Record<string, unknown>) };
    for (const key of Object.keys(headers)) {
      if (names.includes(key.toLowerCase())) delete headers[key];
    }
    return [...rest.slice(0, index), headers, ...rest.slice(index + 1)];
  }

  /**
   * The Vary value already present, from the setHeader state and the writeHead
   * args combined. The two live separately: better-auth writes via setHeader,
   * while oRPC's CORS plugin passes `Vary: Origin` in the writeHead headers
   * argument. Both must survive — dropping either one would let a cache serve
   * a response negotiated for the wrong caller.
   */
  function mergedVary(rest: unknown[]): string | undefined {
    const parts = new Set<string>();
    const fromState = res.getHeader("Vary");
    if (fromState !== undefined) {
      for (const part of Array.isArray(fromState) ? fromState.map(String) : [String(fromState)]) {
        parts.add(part);
      }
    }
    const index = rest.findIndex(
      (arg) => typeof arg === "object" && arg !== null && !Array.isArray(arg),
    );
    if (index !== -1) {
      const headers = rest[index] as Record<string, string | string[] | number | undefined>;
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "vary" && headers[key] !== undefined) {
          const value = headers[key];
          for (const part of Array.isArray(value) ? value : [String(value)]) {
            parts.add(part);
          }
        }
      }
    }
    return parts.size > 0 ? [...parts].join(", ") : undefined;
  }

  /** Sends the stashed header block (mutating it first if compressing). */
  function flush(compressed: boolean, contentLength?: number): void {
    if (flushed || !stashed) return;
    flushed = true;
    const status = stashed.status;
    let rest = stashed.rest;
    if (candidate && compressed) {
      // All mutations must happen before the real writeHead: Node throws
      // ERR_HTTP_HEADERS_SENT once the header block is stored.
      if (pendingEncoding) res.setHeader("Content-Encoding", pendingEncoding);
      const existingVary = mergedVary(rest);
      res.setHeader(
        "Vary",
        existingVary ? `${existingVary}, Accept-Encoding` : "Accept-Encoding",
      );
      // The compressed body has a different size than the one the handler
      // computed; a stale length would truncate or hang the client.
      res.removeHeader("content-length");
      // removeHeader only clears the setHeader state — Node re-applies the
      // writeHead-args headers on top of it, so a Content-Length or Vary
      // passed in the args would survive and override the values above
      // (oRPC's CORS plugin passes Vary: Origin exactly this way). Strip
      // both from a copy.
      rest = stripHeaders(rest, ["content-length", "vary"]);
      // The exact size is known at this point, and Node only auto-sets
      // Content-Length for a single-call end(body) — a write()-then-end()
      // compressed response would otherwise go out chunked. This replaces the
      // handler's stale value with the compressed size.
      if (contentLength !== undefined) {
        res.setHeader("Content-Length", String(contentLength));
      }
    }
    stashed = null;
    // Forwarded untouched — preserves the (status), (status, headers),
    // (status, reason, headers) and (status, reason) shapes, and lets Node
    // re-merge the writeHead-arg headers against the setHeader state.
    originalWriteHead(status, ...(rest as []));
  }

  res.writeHead = (status: number, ...rest: unknown[]) => {
    applyDefaults();
    if (flushed) {
      // Mirror Node's own ERR_HTTP_HEADERS_SENT: headers are immutable once
      // the response has started.
      throw new Error("Cannot call writeHead after the response has been sent");
    }
    if (stashed) {
      // A second writeHead before end replaces the first. With the real
      // writeHead deferred, this is what keeps request-handler's catch path —
      // `writeHead(500)` guarded on `res.headersSent` being false — producing
      // a clean 500 instead of throwing its way to unhandledRejection and
      // triggering a server shutdown.
      chunks = [];
      writeCallbacks = [];
    }
    stashed = { status, rest };

    const headersArg = rest.find(
      (arg): arg is OutgoingHttpHeaders =>
        typeof arg === "object" && arg !== null && !Array.isArray(arg),
    );
    const merged = mergedHeaders(headersArg);
    const encoding = bestEncoding(req.headers["accept-encoding"]);
    candidate =
      encoding !== null &&
      status !== 204 &&
      status !== 304 &&
      (status < 300 || status >= 400) &&
      req.method !== "HEAD" &&
      merged["content-type"]?.toLowerCase().startsWith("application/json") === true &&
      merged["content-encoding"] === undefined;
    if (candidate) {
      pendingEncoding = encoding;
      chunks = [];
    } else {
      // Not a compression candidate — behave exactly like an undecorated
      // response: header block goes out now, body bytes pass through.
      flush(false);
    }
    return res;
  };

  res.write = (
    chunk: unknown,
    encoding?: unknown,
    callback?: WriteCallback,
  ) => {
    if (!candidate) {
      // Forward untouched, preserving the caller's argument shape: the
      // overloaded original accepts (chunk), (chunk, encoding),
      // (chunk, encoding, cb) and (chunk, cb) — this re-materialises
      // whichever one the caller used.
      const args: unknown[] = [chunk];
      if (encoding !== undefined) args.push(encoding);
      if (callback !== undefined) args.push(callback);
      return originalWrite(...(args as Parameters<typeof res.write>));
    }
    if (typeof encoding === "function") {
      callback = encoding as unknown as WriteCallback;
      encoding = undefined;
    }
    if (chunk != null) {
      chunks.push(
        typeof chunk === "string"
          ? Buffer.from(chunk, (encoding as BufferEncoding | undefined) ?? "utf8")
          : Buffer.from(chunk as Uint8Array),
      );
    }
    if (callback) writeCallbacks.push(callback);
    // Buffering means no backpressure is needed; bodies are bounded JSON.
    return true;
  };

  res.end = (...args: unknown[]) => {
    let [chunk, encoding] = args as [unknown, unknown];
    let callback: WriteCallback | undefined;
    if (typeof chunk === "function") {
      callback = chunk as unknown as WriteCallback;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding as unknown as WriteCallback;
      encoding = undefined;
    }

    if (!candidate) {
      // Never intercept non-compressed flows — static files, redirects,
      // plain-text 404s — so they stay byte-identical.
      applyDefaults();
      const args: unknown[] = [];
      if (chunk !== undefined) args.push(chunk);
      if (encoding !== undefined) args.push(encoding);
      if (callback) args.push(callback);
      return originalEnd(...(args as Parameters<typeof res.end>));
    }

    if (chunk != null) {
      chunks.push(
        typeof chunk === "string"
          ? Buffer.from(chunk, (encoding as BufferEncoding | undefined) ?? "utf8")
          : Buffer.from(chunk as Uint8Array),
      );
    }
    const body = Buffer.concat(chunks);
    // A response already flushed by flushHeaders() has advertised
    // Content-Encoding, so whatever body follows must be compressed too —
    // the size threshold only applies when we still own the header block.
    compress = flushed ? true : body.length >= MIN_COMPRESS_BODY_BYTES;
    const payload =
      body.length > 0 && compress
        ? pendingEncoding === "br"
          ? brotliCompressSync(body)
          : gzipSync(body)
        : body;
    flush(compress, compress ? payload.length : undefined);

    if (payload.length > 0) originalWrite(payload);
    for (const writeCb of writeCallbacks) writeCb();
    if (callback) originalEnd(callback);
    else originalEnd();
    return res;
  };

  // Nothing in the app calls flushHeaders (grepped better-auth, oRPC and
  // request-handler), but patch it anyway so a future caller of a compressed
  // response does not send a header block with no Content-Encoding while the
  // deferred end() then compresses underneath it.
  res.flushHeaders = (...args: unknown[]) => {
    applyDefaults();
    if (candidate && !flushed) flush(true);
    return originalFlushHeaders(...(args as Parameters<typeof res.flushHeaders>));
  };

  return res;
}
