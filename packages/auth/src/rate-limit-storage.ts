import type { BetterAuthOptions } from "better-auth";

type BetterAuthStorage = NonNullable<NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]>;
/** The pinned Better Auth version supports atomic consume; never use its legacy fallback. */
export type AuthRateLimitStorage = BetterAuthStorage & Required<Pick<BetterAuthStorage, "consume">>;

export interface AuthCounterNamespace {
  getByName(name: string): {
    consume(rule: {
      window: number;
      max: number;
    }): Promise<{ allowed: boolean; retryAfter: number | null }>;
    get(): Promise<{ count: number; lastRequest: number } | null>;
    set(value: { count: number; lastRequest: number }): Promise<void>;
  };
}

/** Retain Better Auth's endpoint policies and IP normalization, replacing only storage. */
export function createAuthRateLimitStorage(counters: AuthCounterNamespace): AuthRateLimitStorage {
  async function counter(key: string) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(["auth", key])),
    );
    const name = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return counters.getByName(name);
  }
  return {
    async consume(key, rule) {
      return (await counter(key)).consume(rule);
    },
    // Required by Better Auth's storage type, although its request path uses
    // consume. Implement them faithfully so no type-only dummy method exists.
    async get(key) {
      const value = await (await counter(key)).get();
      return value ? { key, ...value } : null;
    },
    async set(key, value) {
      await (await counter(key)).set({ count: value.count, lastRequest: value.lastRequest });
    },
  };
}
