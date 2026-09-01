import type { IncomingMessage } from "node:http";

/**
 * Host routing's decision half: which hostname gets the branding site
 * (apps/branding) instead of the app. DNS for the hostname is provisioned on
 * Railway, not in this repo; the serving half is `BRANDING_DIST` wired in
 * `index.ts` through the same static-file handler the SPA uses.
 */

/** The hostname the branding site answers on. */
export const BRANDING_HOST = "about.mytuums.com";

/**
 * Whether this request is addressed to the branding host.
 *
 * The Host header is case-insensitive and may carry a port (direct access to
 * :3001 in dev); neither may change the verdict. A missing, duplicated or
 * otherwise malformed Host simply does not match, and the request keeps the
 * app's behavior — the closed direction for a routing decision.
 */
export function isBrandingHostRequest(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  return host.toLowerCase().split(":", 1)[0] === BRANDING_HOST;
}
