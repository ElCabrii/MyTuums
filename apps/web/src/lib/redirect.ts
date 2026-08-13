/**
 * The `?redirect=` search param is a URL written by the site itself (the gate
 * in `hooks/use-require-signed-in.ts`) but read back from `window.location`
 * and from `href` navigations — and it round-trips through OAuth, where the
 * value travels to the provider and back as part of the callback URL. Nothing
 * in that path can be trusted to have come from the app.
 *
 * An unsanitized redirect is an open redirect: "//evil.com" and
 * "https://evil.com" would both send a freshly signed-in user off-site with
 * a valid session. `navigate({ href })` accepts absolute URLs, so the rule is
 * deliberately strict — a leading slash, and nothing else the browser treats
 * as a scheme or authority.
 */
const REDIRECT_GATE_PAGES = new Set(["/login", "/register", "/two-factor"]);

/**
 * Returns the raw value only when it is safe to send a signed-in user there.
 * Anything else — null, absolute URLs, protocol-relative URLs, whitespace,
 * the auth pages themselves — comes back null so the caller falls back to
 * its default destination.
 */
export function sanitizeRedirect(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length > 2048) return null;
  if (/\s/.test(raw)) return null;
  // Browsers treat backslashes as forward slashes while resolving special
  // URLs. Without this check, `/\\evil.example` is parsed as the
  // protocol-relative URL `//evil.example` and escapes the origin.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  // `raw.split(/[?#]/, 1)[0]` is the pathname only, and an invalid character
  // can only appear in a part of the URL the browser never resolves as a host.
  const pathname = raw.split(/[?#]/, 1)[0];
  if (REDIRECT_GATE_PAGES.has(pathname)) return null;
  return raw;
}
