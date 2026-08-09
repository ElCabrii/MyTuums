import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { bestEncoding, type Compression } from "./compression.js";
import { NONBLOCKING_STYLESHEET_ONLOAD_HANDLER } from "@my-tuums/api/constants";

/**
 * One place to add per-response headers and compress JSON bodies, applied to
 * the `res` the `createServer` callback hands every handler (health, better-auth,
 * oRPC, media redirects, static files, 404/500). A single choke point means no
 * per-branch edits: `index.ts` wraps the response once and every writer sees
 * the decorated object.
 *
 * Two behaviours live here:
 *
 * 1. Security headers, including the Content-Security-Policy (see its own
 *    doc comment below for the directive-by-directive derivation — issue
 *    #61). Applied via `setHeader` guarded by `hasHeader`, so a handler that
 *    sets one itself keeps its value (inner wins). That guard is what makes
 *    this safe for better-auth, which writes headers through `setHeader`
 *    rather than the `writeHead` headers argument.
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

/**
 * The sha256 hash of the ONE inline event-handler attribute this app's built
 * `index.html` ships (`apps/web/build-inject-plugin.ts`'s stylesheet-swap
 * `onload`). CSP's `script-src` governs inline `onload=`/`onclick=`/etc. by
 * default, same as it governs `<script>` bodies, and there is no nonce path
 * for an attribute baked into a static build artefact the server merely
 * serves unmodified — a nonce has to be minted per-response and echoed into
 * the HTML at serve time, which would mean templating `index.html` on every
 * request instead of serving the prebuilt file as-is (`static-files.ts`).
 *
 * A hash-source is the documented alternative for exactly this shape, gated
 * behind `'unsafe-hashes'` (CSP3) because hash-sources apply to attributes
 * only with that keyword present. Computed from the shared constant rather
 * than pasted as a literal so the two sides cannot drift silently — see the
 * constant's doc comment.
 */
const STYLESHEET_SWAP_HANDLER_HASH = `sha256-${createHash("sha256")
  .update(NONBLOCKING_STYLESHEET_ONLOAD_HANDLER, "utf8")
  .digest("base64")}`;

/**
 * Enforced (not report-only — issue #61) on every response. Derived from what
 * the app actually loads and renders, not a generic template:
 *
 * - `default-src 'self'`, `base-uri 'self'`, `object-src 'none'`: the
 *   standard zero-cost hardening trio. `object-src none` closes the
 *   `<object>`/`<embed>` plugin-content vector Flash-era CSP guides call out;
 *   `base-uri` stops an injected `<base>` tag from rewriting every relative
 *   URL on the page (script `src`, form actions, links) to an attacker's
 *   origin.
 * - `img-src 'self' https:`: images come from two places, and neither is a
 *   single origin that can be pinned. Own uploads are served from this
 *   origin as `/media/<key>`, which 302s the BROWSER to a presigned URL on
 *   the storage bucket's endpoint (`S3_ENDPOINT`) — a value that is
 *   per-environment, has already changed once (see `packages/api/src/
 *   storage.ts`'s `StorageConfig.endpoint` doc), and is not threaded into
 *   this module. Separately, `user.image`/`bannerImage` (packages/auth) hold
 *   an OAuth provider's own avatar URL verbatim until someone uploads a
 *   replacement (`apps/web/src/components/user-avatar.tsx` renders
 *   `user.image` unmodified) — Google, Discord and Twitch avatar CDNs, none
 *   of which this app controls or should enumerate. `https:` is the honest
 *   statement of that: no bare-HTTP or non-network scheme, everything else is
 *   already scoped by same-origin session checks before it ever reaches an
 *   `<img>` tag.
 * - `font-src 'self'`: `@fontsource-variable/inter` ships the font files
 *   through the build; nothing is fetched from a font CDN.
 * - `script-src 'self' https://accounts.google.com 'unsafe-hashes'
 *   '<STYLESHEET_SWAP_HANDLER_HASH>'`: the app's own bundle is same-origin
 *   module scripts only — no other inline `<script>` exists. Google One Tap
 *   (`packages/auth`'s `oneTap()` plugin, wired client-side in
 *   `apps/web/src/lib/one-tap.ts`) loads `https://accounts.google.com/gsi/
 *   client` via a dynamically injected `<script>` tag (better-auth's
 *   `loadGoogleScript`), so the host has to be allowed; the classic OAuth
 *   redirect flows (Google without One Tap, Discord, Twitch — `atoms/
 *   auth.ts`'s `signInWithProviderAtom`) are plain top-level navigations
 *   (`window.location.href = <authorize URL>`), which CSP does not gate at
 *   all, so they need nothing here. The hash-source is the one inline
 *   handler covered above.
 * - `style-src 'self' 'unsafe-inline' https://accounts.google.com`:
 *   `'unsafe-inline'` is unavoidable, not an oversight. Base UI
 *   (`@base-ui/react`, what shadcn's `base-maia` style in this repo is built
 *   on — see `apps/web/components.json`) positions every popover/menu/select/
 *   dialog with Floating UI under the hood, which writes the computed
 *   position as a React `style` prop (`useAnchorPositioning`'s
 *   `positionerStyles`) — an inline `style=""` attribute, recomputed on every
 *   reposition. `style-src` (absent a split `style-src-attr`) governs inline
 *   style attributes exactly like it governs inline `<style>` blocks, and
 *   there is no hash or nonce path for a value that changes on every scroll
 *   and resize. The cold-load splash's inline `<style>` block
 *   (`apps/web/index.html`) rides the same allowance. Locking this down would
 *   mean dropping Floating UI–based positioning app-wide — out of scope here.
 *   The Google host is the fourth One Tap allowance, alongside `script-src`,
 *   `connect-src` and `frame-src` above: the GSI script this app loads
 *   injects its own stylesheet link (documented at
 *   `https://accounts.google.com/gsi/style`), and without this host that
 *   `<link>` is blocked by this same policy — a CSP violation on every
 *   sign-in page load, and an unstyled One Tap prompt on the non-FedCM
 *   fallback path. The bare host (not the `/gsi/style` path) matches this
 *   policy's `script-src`/`connect-src`/`frame-src` entries and covers the
 *   documented path, since a CSP source with no path component matches every
 *   path on that origin.
 * - `connect-src 'self' https://accounts.google.com`: `'self'` covers `/rpc`,
 *   `/api/auth` and `/media`, the app's entire fetch surface. One Tap's
 *   loaded script makes its own requests (credential fetch, FedCM
 *   `.well-known` discovery) back to Google from the page's origin context,
 *   so it needs the same host as `script-src`.
 * - `frame-src https://accounts.google.com`: One Tap's prompt UI itself
 *   renders in a Google-hosted iframe the loaded script creates. Nothing
 *   else in this app frames anything.
 * - `form-action 'self'`: every `<form>` in the app (`apps/web/src/routes/
 *   **`, `components/settings/**`, `components/composer-form.tsx`) submits
 *   via a JS `onSubmit` handler (fetch/oRPC/better-auth client), never a
 *   native `action=` attribute — so this costs nothing and closes off a
 *   form-based exfiltration vector an injected `<form>` could otherwise use.
 * - `frame-ancestors 'none'`: the CSP3 successor to `X-Frame-Options: DENY`
 *   above. Kept alongside it rather than replacing it — older
 *   browsers/crawlers that predate `frame-ancestors` (or a proxy that strips
 *   CSP but not legacy headers) still get the protection from the older
 *   header, and the two never disagree (both mean "never frame this").
 *
 * What a human should watch after deploy, because it cannot be verified from
 * here: whether Google ever serves GSI/FedCM assets from a *different*
 * `accounts.google.com` subpath or a second host (their docs recommend the
 * bare host over enumerating `/gsi/...` paths for exactly this churn risk,
 * which is why this policy already uses the bare host) — and whether a
 * future `S3_ENDPOINT` migration needs `img-src` narrowed again once a stable
 * per-environment origin is worth threading into this module.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "img-src 'self' https:",
  "font-src 'self'",
  `script-src 'self' https://accounts.google.com 'unsafe-hashes' '${STYLESHEET_SWAP_HANDLER_HASH}'`,
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "connect-src 'self' https://accounts.google.com",
  "frame-src https://accounts.google.com",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The per-response security headers, applied to every response that does not
 * already set one (inner wins — see `applyDefaults`).
 */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  // Browsers ignore HSTS received over plain HTTP, so this is inert on
  // localhost and the e2e suite, and effective once the Railway edge (which
  // terminates TLS) forwards it to a browser.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  // Applied unconditionally, not just in production: this server never serves
  // HTML except when `WEB_DIST` is set (`index.ts`), and every other response
  // it ever sends — JSON, redirects, plain-text errors — is fetched via
  // XHR/fetch or followed as a subresource, contexts CSP response headers do
  // not police. Sending it in dev too (where Vite proxies `/rpc`, `/api/auth`
  // and `/media` here, but serves the actual document itself) is inert, not
  // risky, and keeps this module's output identical across environments —
  // see the directive-by-directive reasoning above.
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
};

/** Bodies smaller than this are sent identity — compressing them costs CPU for nothing. */
const MIN_COMPRESS_BODY_BYTES = 1024;

/** The callback shape `res.write(chunk, cb)` and `res.end(chunk, cb)` accept. */
type WriteCallback = (error?: Error | null) => void;

/**
 * Parses the `(chunk)`, `(chunk, encoding)`, `(chunk, encoding, cb)` and
 * `(chunk, cb)` argument shapes `end` accepts into a single triple, so `end`
 * itself only ever sees one shape. Extracted so the override bodies stay
 * small; the overload resolution is the fiddly part.
 *
 * Note the three-arg `(chunk, encoding, cb)` shape: Node's own `end` accepts
 * it, but its callback is dropped here for compression candidates (only
 * `(chunk, cb)` and `(chunk, encoding, cb)` where cb is the second arg are
 * honoured) — every writer in this app calls `end` with at most two
 * arguments, so the drop is unreachable in practice. Kept as-is to preserve
 * the pre-refactor behaviour exactly.
 */
function parseEndArgs(args: unknown[]): {
  chunk: unknown;
  encoding: unknown;
  callback: WriteCallback | undefined;
} {
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
  return { chunk, encoding, callback };
}

/** Body bytes from the chunk shapes `write`/`end` accept (string or Uint8Array). */
function toBuffer(chunk: unknown, encoding: unknown): Buffer {
  return typeof chunk === "string"
    ? Buffer.from(chunk, (encoding as BufferEncoding | undefined) ?? "utf8")
    : Buffer.from(chunk as Uint8Array);
}

/**
 * The per-response wrapper: one instance owns the mutable state the four
 * overrides share and patches them onto `res` (see `attach`). A class rather
 * than a single closure because the state — the deferred header block, the
 * buffered body bytes, the compression decision — is read and written by
 * every override; as one function that closure had grown to 72 decision
 * points and ~40 called functions, past what a single body can be reasoned
 * about. Each override keeps a bounded body here and `decorateResponse`
 * below is just the factory.
 */
class DecoratedResponse {
  private readonly originalWriteHead: ServerResponse["writeHead"];
  private readonly originalWrite: ServerResponse["write"];
  private readonly originalEnd: ServerResponse["end"];
  private readonly originalFlushHeaders: ServerResponse["flushHeaders"];

  private defaultsApplied = false;
  // The writeHead call being deferred for compression candidates.
  private stashed: { status: number; rest: unknown[] } | null = null;
  // True when this response would be compressed if the body is big enough.
  private candidate = false;
  private pendingEncoding: Compression = null;
  // Body bytes (and write callbacks) accumulated while the header block waits.
  private chunks: Buffer[] = [];
  private writeCallbacks: WriteCallback[] = [];
  private flushed = false;

  constructor(
    private readonly req: IncomingMessage,
    private readonly res: ServerResponse,
  ) {
    this.originalWriteHead = res.writeHead.bind(res);
    this.originalWrite = res.write.bind(res);
    this.originalEnd = res.end.bind(res);
    this.originalFlushHeaders = res.flushHeaders.bind(res);
  }

  /** Wires the overrides onto `res` and returns it, so `decorateResponse` can hand back the real object. */
  attach(): ServerResponse {
    this.res.writeHead = this.writeHead;
    this.res.write = this.write;
    this.res.end = this.end;
    this.res.flushHeaders = this.flushHeaders;
    return this.res;
  }

  private applyDefaults(): void {
    if (this.defaultsApplied) return;
    this.defaultsApplied = true;
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      // Inner wins: a handler that sets one of these deliberately keeps its
      // value, for both the setHeader path (better-auth) and the writeHead
      // headers-argument path (everything else) — Node merges writeHead-arg
      // headers on top of the setHeader state.
      if (!this.res.hasHeader(name)) this.res.setHeader(name, value);
    }
  }

  /** The effective header view (setHeader state + writeHead args), lowercased. */
  private mergedHeaders(headersArg: OutgoingHttpHeaders | undefined): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.res.getHeaders())) {
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
  private stripHeaders(rest: unknown[], names: string[]): unknown[] {
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
  private mergedVary(rest: unknown[]): string | undefined {
    const parts = new Set<string>();
    const fromState = this.res.getHeader("Vary");
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
  private flush(compressed: boolean, contentLength?: number): void {
    if (this.flushed || !this.stashed) return;
    this.flushed = true;
    const status = this.stashed.status;
    let rest = this.stashed.rest;
    if (this.candidate && compressed) {
      // All mutations must happen before the real writeHead: Node throws
      // ERR_HTTP_HEADERS_SENT once the header block is stored.
      if (this.pendingEncoding) this.res.setHeader("Content-Encoding", this.pendingEncoding);
      const existingVary = this.mergedVary(rest);
      this.res.setHeader(
        "Vary",
        existingVary ? `${existingVary}, Accept-Encoding` : "Accept-Encoding",
      );
      // The compressed body has a different size than the one the handler
      // computed; a stale length would truncate or hang the client.
      this.res.removeHeader("content-length");
      // removeHeader only clears the setHeader state — Node re-applies the
      // writeHead-args headers on top of it, so a Content-Length or Vary
      // passed in the args would survive and override the values above
      // (oRPC's CORS plugin passes Vary: Origin exactly this way). Strip
      // both from a copy.
      rest = this.stripHeaders(rest, ["content-length", "vary"]);
      // The exact size is known at this point, and Node only auto-sets
      // Content-Length for a single-call end(body) — a write()-then-end()
      // compressed response would otherwise go out chunked. This replaces the
      // handler's stale value with the compressed size.
      if (contentLength !== undefined) {
        this.res.setHeader("Content-Length", String(contentLength));
      }
    }
    this.stashed = null;
    // Forwarded untouched — preserves the (status), (status, headers),
    // (status, reason, headers) and (status, reason) shapes, and lets Node
    // re-merge the writeHead-arg headers against the setHeader state.
    this.originalWriteHead(status, ...(rest as []));
  }

  writeHead = (status: number, ...rest: unknown[]) => {
    this.applyDefaults();
    if (this.flushed) {
      // Mirror Node's own ERR_HTTP_HEADERS_SENT: headers are immutable once
      // the response has started.
      throw new Error("Cannot call writeHead after the response has been sent");
    }
    if (this.stashed) {
      // A second writeHead before end replaces the first. With the real
      // writeHead deferred, this is what keeps request-handler's catch path —
      // `writeHead(500)` guarded on `res.headersSent` being false — producing
      // a clean 500 instead of throwing its way to unhandledRejection and
      // triggering a server shutdown.
      this.chunks = [];
      this.writeCallbacks = [];
    }
    this.stashed = { status, rest };

    const headersArg = rest.find(
      (arg): arg is OutgoingHttpHeaders =>
        typeof arg === "object" && arg !== null && !Array.isArray(arg),
    );
    const merged = this.mergedHeaders(headersArg);
    const encoding = bestEncoding(this.req.headers["accept-encoding"]);
    this.candidate =
      encoding !== null &&
      status !== 204 &&
      status !== 304 &&
      (status < 300 || status >= 400) &&
      this.req.method !== "HEAD" &&
      merged["content-type"]?.toLowerCase().startsWith("application/json") === true &&
      merged["content-encoding"] === undefined;
    if (this.candidate) {
      this.pendingEncoding = encoding;
      this.chunks = [];
    } else {
      // Not a compression candidate — behave exactly like an undecorated
      // response: header block goes out now, body bytes pass through.
      this.flush(false);
    }
    return this.res;
  };

  write = (chunk: unknown, encoding?: unknown, callback?: WriteCallback) => {
    if (!this.candidate) {
      // Forward untouched, preserving the caller's argument shape: the
      // overloaded original accepts (chunk), (chunk, encoding),
      // (chunk, encoding, cb) and (chunk, cb) — this re-materialises
      // whichever one the caller used.
      const args: unknown[] = [chunk];
      if (encoding !== undefined) args.push(encoding);
      if (callback !== undefined) args.push(callback);
      return this.originalWrite(...(args as Parameters<ServerResponse["write"]>));
    }
    if (typeof encoding === "function") {
      callback = encoding as unknown as WriteCallback;
      encoding = undefined;
    }
    if (chunk != null) {
      this.chunks.push(toBuffer(chunk, encoding));
    }
    if (callback) this.writeCallbacks.push(callback);
    // Buffering means no backpressure is needed; bodies are bounded JSON.
    return true;
  };

  end = (...args: unknown[]) => {
    const { chunk, encoding, callback } = parseEndArgs(args);

    if (!this.candidate) {
      // Never intercept non-compressed flows — static files, redirects,
      // plain-text 404s — so they stay byte-identical.
      this.applyDefaults();
      const passthrough: unknown[] = [];
      if (chunk !== undefined) passthrough.push(chunk);
      if (encoding !== undefined) passthrough.push(encoding);
      if (callback) passthrough.push(callback);
      return this.originalEnd(...(passthrough as Parameters<ServerResponse["end"]>));
    }

    if (chunk != null) {
      this.chunks.push(toBuffer(chunk, encoding));
    }
    const body = Buffer.concat(this.chunks);
    // A response already flushed by flushHeaders() has advertised
    // Content-Encoding, so whatever body follows must be compressed too —
    // the size threshold only applies when we still own the header block.
    const compress = this.flushed || body.length >= MIN_COMPRESS_BODY_BYTES;
    let payload: Buffer;
    if (body.length > 0 && compress) {
      if (this.pendingEncoding === "br") {
        // Brotli quality is set explicitly, never inherited: the zlib
        // default (11) is for assets compressed once at build time, but
        // this runs per request, synchronously, on the only thread — ~10
        // ms of blocked event loop per feed page for a few percent of
        // bytes (issue #54). Quality 4 is the standard dynamic-content
        // range; the trade is a few percent of bytes for an order of
        // magnitude less CPU.
        payload = brotliCompressSync(body, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
        });
      } else {
        payload = gzipSync(body);
      }
    } else {
      payload = body;
    }
    this.flush(compress, compress ? payload.length : undefined);

    if (payload.length > 0) this.originalWrite(payload);
    for (const writeCb of this.writeCallbacks) writeCb();
    if (callback) this.originalEnd(callback);
    else this.originalEnd();
    return this.res;
  };

  // Nothing in the app calls flushHeaders (grepped better-auth, oRPC and
  // request-handler), but patch it anyway so a future caller of a compressed
  // response does not send a header block with no Content-Encoding while the
  // deferred end() then compresses underneath it.
  flushHeaders = (...args: unknown[]) => {
    this.applyDefaults();
    if (this.candidate && !this.flushed) this.flush(true);
    return this.originalFlushHeaders(...(args as Parameters<ServerResponse["flushHeaders"]>));
  };
}

/**
 * Wraps `res` so every response gets the security headers and, when eligible,
 * gzip/brotli compression — the module header above is the full contract. The
 * per-response state lives in `DecoratedResponse`; this factory wires its
 * overrides onto `res` and hands the real object back.
 */
export function decorateResponse(req: IncomingMessage, res: ServerResponse): ServerResponse {
  return new DecoratedResponse(req, res).attach();
}
