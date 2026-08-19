/**
 * The connection policy shared by every `postgres` client this package opens.
 *
 * `requiresTls` is the one rule that must not drift between the process-wide
 * pool (./index.ts) and the one-shot maintenance scripts (./promote.ts): a
 * client that skips it either sends credentials in the clear against a dotted
 * hostname, or fails a TLS handshake against a loopback/single-label host that
 * does not terminate TLS. Keeping it here, and reusing it from both, is what
 * makes the promote path safe to run against production.
 */

/**
 * Whether to require TLS for this connection. Loopback addresses obviously
 * don't need it. Container orchestrators (Docker Compose, Kubernetes, ...)
 * resolve service-to-service hostnames as a single DNS label with no dot
 * (e.g. `postgres`, `postgres.svc`) inside a network that's already private
 * and un-routable from outside — and don't terminate TLS on it. A dotted
 * hostname is treated as a real DNS name (managed cloud DB, VPC endpoint,
 * ...) and requires TLS. This replaces an earlier version that only
 * special-cased `localhost`/`127.0.0.1` literally, which meant Postgres
 * looked "unreachable" from inside Docker Compose — the driver was
 * attempting a TLS handshake against a server that doesn't speak TLS.
 */
export function requiresTls(url: string): boolean {
  const { hostname } = new URL(url);
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return false;
  }
  return hostname.includes(".");
}

/**
 * The `ssl` option for a `postgres` client, derived from the connection URL.
 * `"require"` for dotted hostnames, `false` otherwise — the same rule the
 * process-wide pool applies.
 */
export function sslFor(url: string): "require" | false {
  return requiresTls(url) ? "require" : false;
}
