import type { IncomingMessage } from "node:http";

/**
 * The caller's IP, for the rate limiter's anonymous-caller identity
 * (packages/api/src/procedures.ts).
 *
 * `X-Forwarded-For` is only consulted when TRUST_PROXY is on, and this is the
 * whole reason that flag exists. The header is client-supplied: with a
 * direct-to-internet server, honouring it lets anyone send a different
 * `X-Forwarded-For` on every request and get a fresh rate limit bucket each
 * time — which quietly removes the limit rather than enforcing it. Only a
 * proxy that *overwrites* the header (rather than appending to whatever the
 * client sent) makes it trustworthy, so trusting it has to be an explicit
 * deployment statement, not a default.
 */
export function resolveClientIp(req: IncomingMessage, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    // Node gives an array only when the header appeared more than once.
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;

    // Left-most entry is the original client; the rest are the proxies it
    // passed through.
    const client = raw?.split(",")[0]?.trim();
    if (client) return normalise(client);
  }

  const remote = req.socket.remoteAddress;
  return remote ? normalise(remote) : undefined;
}

/**
 * Collapses IPv4-mapped IPv6 (`::ffff:203.0.113.9`) onto the plain IPv4 form
 * so the same client doesn't get two rate limit buckets depending on whether
 * it reached us over a dual-stack socket.
 */
function normalise(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped?.[1] ?? ip;
}
