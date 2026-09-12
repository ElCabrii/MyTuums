import type { RateLimiter, RateLimitPolicy, RateLimitResult } from "./rate-limit.js";

/** Stable opaque names avoid placing IPs, user IDs or appeal capabilities in DO names. */
export function createDistributedRateLimiter(counters: {
  getByName(name: string): { consume(policy: RateLimitPolicy): Promise<RateLimitResult> };
}): RateLimiter {
  return {
    async consume(key, policy) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([policy.name, key])),
      );
      const name = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      // A failed or ambiguous RPC must fail closed. Retrying could consume twice;
      // an HTTP caller may retry normally, but never receive unmetered admission.
      return counters.getByName(name).consume(policy);
    },
  };
}
