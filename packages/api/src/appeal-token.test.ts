import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPEAL_TOKEN_TTL_MS,
  APPEAL_TOKEN_MAX_LENGTH,
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

/** Signs an arbitrary payload so verification tests can cross the typed signer's boundary honestly. */
function signMalformed<Payload>(payload: Payload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

describe("createAppealTokenSigner", () => {
  it("round-trips a payload through sign/verify", async () => {
    const { sign, verify } = createAppealTokenSigner(SECRET);
    const original = payload();
    const token = await sign(original);

    const decoded = await verify(token);
    expect(decoded).toEqual(original);
  });

  it("preserves the existing Node HMAC format, including Unicode payloads", async () => {
    const signer = createAppealTokenSigner(SECRET);
    const original = payload({ userId: "auteur-é🎮", nonce: "unicode-秘密" });
    const legacy = signMalformed(original);
    expect(await signer.sign(original)).toBe(legacy);
    expect(await signer.verify(legacy)).toEqual(original);
  });

  it("refuses an absent or short signing secret and never emits oversized capabilities", async () => {
    for (const secret of ["", " ".repeat(40), "short"]) {
      expect(() => createAppealTokenSigner(secret)).toThrow("at least 32");
    }
    const signer = createAppealTokenSigner(SECRET);
    await expect(
      signer.sign(payload({ nonce: "x".repeat(APPEAL_TOKEN_MAX_LENGTH) })),
    ).rejects.toThrow("too large");
  });

  it("encodes as two base64url halves joined by a dot — opaque, unpadded", async () => {
    const { sign } = createAppealTokenSigner(SECRET);
    const token = await sign(payload());
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createAppealTokenSigner(SECRET).sign(payload());
    expect(
      await createAppealTokenSigner("another-secret-32-chars-xxxxxxxxxx").verify(token),
    ).toBeNull();
  });

  describe("verify: signature", () => {
    it("rejects a tampered payload — flipping any field breaks the MAC", async () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const original = payload();
      const token = await sign(original);

      for (const tampered of [
        { ...original, userId: randomUUID() },
        { ...original, actionId: randomUUID() },
        { ...original, nonce: "different-nonce" },
        { ...original, purpose: "ban" },
        { ...original, iat: original.iat - 1000 },
      ]) {
        const body = Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url");
        const signature = token.slice(token.lastIndexOf(".") + 1);
        expect(await verify(`${body}.${signature}`)).toBeNull();
      }
    });

    it("rejects oversized input and implausible signature encodings before verification", async () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const token = await sign(payload());
      const body = bodyOf(token);

      expect(await verify(`${"a".repeat(APPEAL_TOKEN_MAX_LENGTH)}.${"a".repeat(43)}`)).toBeNull();
      expect(await verify(`${body}.${"a".repeat(42)}`)).toBeNull();
      expect(await verify(`${body}.${"a".repeat(44)}`)).toBeNull();
      expect(await verify(`${body}.${"!".repeat(43)}`)).toBeNull();
    });

    it("rejects a noncanonical base64url signature with equivalent decoded bytes", async () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const token = await sign(payload());
      const dot = token.lastIndexOf(".");
      const signature = token.slice(dot + 1);
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const finalIndex = alphabet.indexOf(signature.at(-1)!);
      const alias = `${signature.slice(0, -1)}${alphabet[finalIndex + 1]}`;

      expect(finalIndex % 4).toBe(0);
      expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(signature, "base64url"));
      expect(await verify(`${token.slice(0, dot + 1)}${alias}`)).toBeNull();
    });
  });

  describe("verify: payload schema", () => {
    it("rejects a malformed token with no dot, or nothing after it", async () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const token = await sign(payload());
      expect(await verify("")).toBeNull();
      expect(await verify("no-dot-here")).toBeNull();
      expect(await verify(`${bodyOf(token)}.`)).toBeNull();
      expect(await verify(`${bodyOf(token)}.not-base64!!`)).toBeNull();
    });

    it("rejects a token whose payload isn't JSON", async () => {
      const { verify } = createAppealTokenSigner(SECRET);
      const body = Buffer.from("not json at all", "utf8").toString("base64url");
      const signature = createHmac("sha256", SECRET).update(body).digest("base64url");
      expect(await verify(`${body}.${signature}`)).toBeNull();
    });

    it("rejects a token missing a required field, or carrying the wrong purpose", async () => {
      const { verify } = createAppealTokenSigner(SECRET);
      const valid = payload();
      const tokens = [
        signMalformed({ ...valid, nonce: undefined }),
        signMalformed({ ...valid, purpose: "password-reset" }),
        signMalformed({ ...valid, iat: "not-a-number" }),
      ];
      for (const token of tokens) {
        expect(await verify(token)).toBeNull();
      }
    });
  });

  describe("verify: TTL", () => {
    const now = Date.UTC(2026, 7, 6, 12, 0, 0);

    it("accepts a token minted just now and one within the week", async () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const fresh = await sign({ ...payload(), iat: Math.floor(now / 1000) });
      const within = await sign({
        ...payload(),
        iat: Math.floor((now - APPEAL_TOKEN_TTL_MS + 1000) / 1000),
      });
      expect(await verify(fresh, now)).not.toBeNull();
      expect(await verify(within, now)).not.toBeNull();
    });

    it("rejects a token at the TTL boundary and beyond — the expiry check is `iat + TTL <= now`", async () => {
      const { sign, verify } = createAppealTokenSigner(SECRET);
      const atBoundary = await sign({
        ...payload(),
        iat: Math.floor((now - APPEAL_TOKEN_TTL_MS) / 1000),
      });
      const expired = await sign({
        ...payload(),
        iat: Math.floor((now - APPEAL_TOKEN_TTL_MS - 10_000) / 1000),
      });
      expect(await verify(atBoundary, now)).toBeNull();
      expect(await verify(expired, now)).toBeNull();
    });
  });
});
