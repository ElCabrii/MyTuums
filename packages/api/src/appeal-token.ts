import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * The payload an appeal token carries (issue #38).
 *
 * `actionId` is the `moderation_action` row the appeal contests, `userId` the
 * account the action happened to — the token binds the appeal to exactly one
 * action and one appellant, which is what stops a link shared onward from
 * appealing someone else's action. `nonce` is the replay-protection half: it
 * is stored on the `appeal` row (`tokenNonce`), so a used link cannot be
 * replayed — a new open of the same action mints a fresh nonce.
 */
const payloadSchema = z.object({
  purpose: z.literal("appeal"),
  actionId: z.uuid(),
  userId: z.string().min(1),
  nonce: z.string().min(1),
  /** Seconds since the epoch. A number, not a Date, so the token stays JSON. */
  iat: z.number().int().positive(),
});

export type AppealTokenPayload = z.infer<typeof payloadSchema>;

/**
 * How long an appeal link stays valid, in milliseconds.
 *
 * A week: long enough that the occasional email-reader who finds the notice
 * days later can still act, short enough that a leaked token is a window, not
 * a permanent key. The appeal page says the link expired when the check
 * fails; the action itself can still be appealed by a signed-in author
 * through the post-stub path.
 */
export const APPEAL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Upper bound for the opaque token accepted by the appeal endpoint.
 *
 * A valid token produced by this module is only a few hundred bytes. Four KiB
 * leaves ample room for a future payload change while keeping an anonymous
 * caller from making the verifier allocate and MAC an arbitrarily large
 * string. The endpoint applies the same bound at its zod boundary; the
 * verifier repeats it because it is also exported as a direct function.
 */
export const APPEAL_TOKEN_MAX_LENGTH = 4 * 1024;

/** SHA-256 in unpadded base64url is always 43 ASCII characters. */
const APPEAL_TOKEN_SIGNATURE_LENGTH = 43;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * An HMAC-SHA256 capability signer for the signed-out appeal links.
 *
 * Format is `base64url(payload).base64url(hmac)` — two base64url halves with
 * a dot, the same shape as the JWT the app already handles, but without a
 * JWT library's surface. Verification is constant-time (timingSafeEqual
 * after a length pre-check) and re-parses the payload through the zod schema
 * — a tampered or malformed token fails one of the three checks (signature,
 * schema, TTL) and is indistinguishable in effect from an invalid one.
 *
 * The `now` parameter exists so unit tests can pin the clock; production
 * calls `verify(raw)` and gets `Date.now()`.
 */
export function createAppealTokenSigner(secret: string) {
  function sign(payload: AppealTokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  function verify(raw: string, now: number = Date.now()): AppealTokenPayload | null {
    // Keep this check before `lastIndexOf`, slicing, decoding, or HMAC work:
    // callers can invoke the verifier directly, outside the oRPC schema.
    if (raw.length === 0 || raw.length > APPEAL_TOKEN_MAX_LENGTH) return null;

    const dot = raw.lastIndexOf(".");
    if (dot <= 0) return null;

    const body = raw.slice(0, dot);
    const encodedSignature = raw.slice(dot + 1);
    // Reject implausible signatures before Buffer.from allocates a decoded
    // buffer. Checking the alphabet also avoids Node's permissive base64
    // decoder accepting punctuation as if it were padding.
    if (
      encodedSignature.length !== APPEAL_TOKEN_SIGNATURE_LENGTH ||
      !BASE64URL_RE.test(encodedSignature)
    ) {
      return null;
    }

    const provided = Buffer.from(encodedSignature, "base64url");
    // Node's decoder accepts non-zero unused pad bits, so distinct strings can
    // decode to the same bytes. Capabilities have one textual representation:
    // require the canonical unpadded base64url encoding before comparing it.
    if (provided.toString("base64url") !== encodedSignature) return null;

    const expected = createHmac("sha256", secret).update(body).digest();

    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }

    const result = payloadSchema.safeParse(parsed);
    if (!result.success) return null;
    if (result.data.iat * 1000 + APPEAL_TOKEN_TTL_MS <= now) return null;

    return result.data;
  }

  return { sign, verify };
}

/**
 * The one signer the app uses, keyed on `BETTER_AUTH_SECRET`.
 *
 * Reusing the auth secret is safe — anyone holding it can already mint
 * sessions and impersonate anyone — and it means the appeal link's security
 * posture is exactly the session system's. The fallback mirrors better-auth's
 * own dev fallback byte-for-byte (dist/context/create-context.mjs:78:
 * `"better-auth-secret-12345678901234567890"`), so a deployment that forgot
 * to set the variable fails identically to one that never had auth working
 * at all — and `apps/server/src/env.ts` requires ≥32 chars of real
 * randomness, so production never actually reaches this line.
 */
const secret = process.env.BETTER_AUTH_SECRET?.trim() || "better-auth-secret-12345678901234567890";

/** The process-wide signer. Unit tests build their own with an injected secret. */
export const appealToken = createAppealTokenSigner(secret);
