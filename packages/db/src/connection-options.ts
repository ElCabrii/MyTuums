/**
 * Whether a database URL points at an endpoint that should use TLS.
 *
 * Loopback and single-label service names are used by local Docker Compose
 * and intentionally keep TLS disabled. Dotted names represent managed or
 * otherwise externally-routed endpoints and use a verified TLS connection.
 */
export function requiresTls(url: string): boolean {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return false;
  }
  return hostname.includes(".");
}

/**
 * postgres.js accepts `verify-full` as the mode that verifies both the peer
 * certificate and its hostname. `require` only encrypts the connection and
 * deliberately disables certificate verification in the driver.
 */
export function sslModeForConnection(url: string): false | "verify-full" {
  return requiresTls(url) ? "verify-full" : false;
}
