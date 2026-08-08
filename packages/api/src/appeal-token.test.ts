import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPEAL_TOKEN_TTL_MS,
  createAppealTokenSigner,
  type AppealTokenPayload,
} from "./appeal-token.js";

const SECRET = "test-secret-with-at-least-32-chars-1234";

/** A valid payload the tests can mutate — `iat` is controlled per test via the `now` parameter instead. */
function payload(overrides: Partial<AppealTokenPayload> = {}): AppealTokenPayload {
  return {
    purpose: "appeal",
    actionId: randomUUID(),
    userId: randomUUID(),
    nonce: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/** Decodes a token's first half — for the shape and tampering tests. */
function bodyOf(raw: string): string {
  return raw.slice(0, raw.lastIndexOf("."));
}

describe("createAppealTokenSigner", () => {
  it("round-trips a payload through sign/verify", () => {
    const { sign, verify } = createAppealTokenSigner(SECRET);
    const original = payload();
    const token = sign(original);

    const decoded = verify(token);
    expect(decoded).toEqual(original);
  });

  it("encodes as two base64url halves joined by a dot — opaque, unpadded", () => {
    const { sign } = createAppealTokenSigner(SECRET);
    const token = sign(payload());
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
  });

  it("rejects a token signed with a different secret", () => {
    const token = createAppealTokenSigner(SECRET).sign(payload());
    expect(createAppealTokenSigner("another-secret-32-chars-xxxxxxxxxx").verify(token)).toBeNull();
  });

  describe("verify: signature", () => {
    it("rejects a tampered payload — flipping any field breaks the MAC", () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const original = payload();
      const token = sign(original);

      for (const tampered of [
        { ...original, userId: randomUUID() },
        { ...original, actionId: randomUUID() },
        { ...original, nonce: "different-nonce" },
        { ...original, purpose: "ban" },
        { ...original, iat: original.iat - 1000 },
      ]) {
        const body = Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url");
        const signature = token.slice(token.lastIndexOf(".") + 1);
        expect(verify(`${body}.${signature}`)).toBeNull();
      }
    });

    it("rejects a truncated or appended signature", () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const token = sign(payload());

      const body = bodyOf(token);
      const signature = token.slice(token.lastIndexOf(".") + 1);
      expect(verify(`${body}.${signature.slice(0, 8)}`)).toBeNull();
      expect(verify(`${body}.${signature}extra`)).toBeNull();
    });
  });

  describe("verify: payload schema", () => {
    it("rejects a malformed token with no dot, or nothing after it", () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const token = sign(payload());
      expect(verify("")).toBeNull();
      expect(verify("no-dot-here")).toBeNull();
      expect(verify(`${bodyOf(token)}.`)).toBeNull();
      expect(verify(`${bodyOf(token)}.not-base64!!`)).toBeNull();
    });

    it("rejects a token whose payload isn't JSON", () => {
      const { verify } = createAppealTokenSigner(SECRET);
      const body = Buffer.from("not json at all", "utf8").toString("base64url");
      const signature = createAppealTokenSigner(SECRET).sign(payload()).slice(-44);
      expect(verify(`${body}.${signature}`)).toBeNull();
    });

    it("rejects a token missing a required field, or carrying the wrong purpose", () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const valid = payload();
      const tokens = [
        sign({ ...valid, nonce: undefined } as unknown as AppealTokenPayload),
        sign({ ...valid, purpose: "password-reset" } as unknown as AppealTokenPayload),
        sign({ ...valid, iat: "not-a-number" } as unknown as AppealTokenPayload),
      ];
      for (const token of tokens) {
        expect(verify(token)).toBeNull();
      }
    });
  });

  describe("verify: TTL", () => {
    const now = Date.UTC(2026, 7, 6, 12, 0, 0);

    it("accepts a token minted just now and one within the week", () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const fresh = sign({ ...payload(), iat: Math.floor(now / 1000) });
      const within = sign({
        ...payload(),
        iat: Math.floor((now - APPEAL_TOKEN_TTL_MS + 1000) / 1000),
      });
      expect(verify(fresh, now)).not.toBeNull();
      expect(verify(within, now)).not.toBeNull();
    });

    it("rejects a token at the TTL boundary and beyond — the expiry check is `iat + TTL <= now`", () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const atBoundary = sign({
        ...payload(),
        iat: Math.floor((now - APPEAL_TOKEN_TTL_MS) / 1000),
      });
      const expired = sign({
        ...payload(),
        iat: Math.floor((now - APPEAL_TOKEN_TTL_MS - 10_000) / 1000),
      });
      expect(verify(atBoundary, now)).toBeNull();
      expect(verify(expired, now)).toBeNull();
    });
  });
});
