import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

/**
 * The minimum a real deployment must set. Everything the auth hardening added
 * is optional on purpose — see packages/auth/src/env.ts — so these tests are
 * mostly about proving that "optional" really is optional, and that the one
 * case which is *not* safe to ignore is caught loudly.
 */
const required = {
  DATABASE_URL: "postgresql://postgres:pw@localhost:5432/mytuums",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3001",
};

describe("parseEnv", () => {
  it("accepts an environment with no OAuth, email or passkey variables at all", () => {
    // The property a fresh clone and CI both depend on: email/password auth
    // boots with nothing but the three required variables.
    const env = parseEnv({ ...required });

    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.PASSKEY_RP_ID).toBeUndefined();
    expect(env.WEB_ORIGIN).toBe("http://localhost:5173");
  });

  it("accepts a fully configured provider", () => {
    const env = parseEnv({
      ...required,
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });

    expect(env.GOOGLE_CLIENT_ID).toBe("id");
    expect(env.GOOGLE_CLIENT_SECRET).toBe("secret");
  });

  /**
   * The failure this check exists for: `packages/auth/src/social.ts` registers
   * a provider only when it has both halves, so an id without a secret does
   * not error anywhere — the provider is simply absent, its button never
   * renders, and nothing says why.
   */
  describe("half-configured OAuth providers", () => {
    it.each([
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
      ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"],
    ])("rejects %s without %s", (idKey, secretKey) => {
      expect(() => parseEnv({ ...required, [idKey]: "id" })).toThrow(secretKey);
    });

    it.each([
      ["GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_ID"],
      ["DISCORD_CLIENT_SECRET", "DISCORD_CLIENT_ID"],
      ["TWITCH_CLIENT_SECRET", "TWITCH_CLIENT_ID"],
    ])("rejects %s without %s", (secretKey, idKey) => {
      expect(() => parseEnv({ ...required, [secretKey]: "s" })).toThrow(idKey);
    });

    it("names only the provider that is half-configured, not the ones left alone", () => {
      const message = (() => {
        try {
          parseEnv({ ...required, DISCORD_CLIENT_ID: "id" });
          return "";
        } catch (error) {
          return String(error);
        }
      })();

      expect(message).toContain("DISCORD_CLIENT_SECRET");
      expect(message).not.toContain("GOOGLE");
      expect(message).not.toContain("TWITCH");
    });

    it("allows several providers configured together", () => {
      expect(() =>
        parseEnv({
          ...required,
          GOOGLE_CLIENT_ID: "g",
          GOOGLE_CLIENT_SECRET: "gs",
          DISCORD_CLIENT_ID: "d",
          DISCORD_CLIENT_SECRET: "ds",
        }),
      ).not.toThrow();
    });
  });

  describe("AUTH_RATE_LIMIT", () => {
    it("is optional and accepts only true/false", () => {
      expect(parseEnv({ ...required }).AUTH_RATE_LIMIT).toBeUndefined();
      expect(parseEnv({ ...required, AUTH_RATE_LIMIT: "false" }).AUTH_RATE_LIMIT).toBe("false");
      expect(() => parseEnv({ ...required, AUTH_RATE_LIMIT: "off" })).toThrow();
    });
  });

  describe("SENTRY_DSN", () => {
    it("is optional and passed through as-is", () => {
      expect(parseEnv({ ...required }).SENTRY_DSN).toBeUndefined();
      expect(
        parseEnv({ ...required, SENTRY_DSN: "https://abc@example.ingest.sentry.io/1" }).SENTRY_DSN,
      ).toBe("https://abc@example.ingest.sentry.io/1");
    });
  });

  describe("pre-existing required variables", () => {
    it("still rejects a short BETTER_AUTH_SECRET", () => {
      expect(() => parseEnv({ ...required, BETTER_AUTH_SECRET: "too-short" })).toThrow(
        "BETTER_AUTH_SECRET",
      );
    });

    it("still rejects a missing DATABASE_URL", () => {
      expect(() =>
        parseEnv({
          BETTER_AUTH_SECRET: required.BETTER_AUTH_SECRET,
          BETTER_AUTH_URL: required.BETTER_AUTH_URL,
        }),
      ).toThrow("DATABASE_URL");
    });
  });
});
