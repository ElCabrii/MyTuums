/**
 * The boot-time fallback for the non-blocking stylesheet trick in
 * `apps/web/build-inject-plugin.ts`.
 *
 * That plugin ships the app's stylesheet as `<link rel="stylesheet"
 * media="print" onload="this.media='all'">` so it downloads without blocking
 * first paint, then flips itself to `media="all"` once loaded. The server's
 * Content-Security-Policy (`apps/server/src/response-decorators.ts`) allows
 * that one inline `onload` by `'unsafe-hashes'` hash-source rather than
 * widening `script-src` — but `'unsafe-hashes'` itself is not universally
 * supported (Firefox < 109, Safari < 15.4, per MDN's compat data), and a
 * browser that ignores the keyword blocks the handler outright, with no
 * `'unsafe-inline'` fallback to fall back to. Nothing else ever promotes the
 * link in that case, so the app would stay unstyled forever — silently, since
 * there is no console to watch for it in production.
 *
 * Calling this once at startup (`main.tsx`) closes that gap unconditionally:
 * it does not depend on `onload` having fired, or on why it didn't. A browser
 * that already ran the inline handler finds nothing to do (the selector below
 * only matches a `<link>` still stuck at `media="print"`); one that couldn't
 * gets promoted here instead.
 */
export function promotePrintStylesheet(): void {
  const stuck = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][media="print"]');
  for (const link of stuck) {
    link.media = "all";
  }
}
