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

/** Capabilities have one textual representation, including unused padding bits. */
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_RE.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    );
    return encode(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * HMAC-SHA256 capabilities use Web Crypto verification and the existing
 * base64url(payload).base64url(signature) format. The entrypoint supplies its
 * secret explicitly; importing this module never reads environment variables.
 */
export function createAppealTokenSigner(secret: string) {
  if (secret.trim().length < 32)
    throw new Error("Appeal signing requires a secret of at least 32 characters.");
  const encoder = new TextEncoder();
  // Import inside the first request, since Workers disallow top-level async I/O.
  let key: ReturnType<typeof crypto.subtle.importKey> | undefined;
  function signingKey() {
    key ??= crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return key;
  }

  async function sign(payload: AppealTokenPayload): Promise<string> {
    const json = JSON.stringify(payloadSchema.parse(payload));
    if (json.length > APPEAL_TOKEN_MAX_LENGTH) throw new Error("Appeal token is too large.");
    const body = encode(encoder.encode(json));
    if (body.length + 1 + APPEAL_TOKEN_SIGNATURE_LENGTH > APPEAL_TOKEN_MAX_LENGTH)
      throw new Error("Appeal token is too large.");
    const signature = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(body));
    return `${body}.${encode(new Uint8Array(signature))}`;
  }

  async function verify(raw: string, now: number = Date.now()): Promise<AppealTokenPayload | null> {
    // Bound allocation and cryptographic work even outside the oRPC schema.
    if (raw.length === 0 || raw.length > APPEAL_TOKEN_MAX_LENGTH) return null;
    const dot = raw.lastIndexOf(".");
    if (dot <= 0) return null;
    const body = raw.slice(0, dot);
    const encodedSignature = raw.slice(dot + 1);
    if (encodedSignature.length !== APPEAL_TOKEN_SIGNATURE_LENGTH) return null;
    const provided = decode(encodedSignature);
    const bytes = decode(body);
    if (!provided || !bytes) return null;
    if (!(await crypto.subtle.verify("HMAC", await signingKey(), provided, encoder.encode(body))))
      return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
      );
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

export type AppealTokenSigner = ReturnType<typeof createAppealTokenSigner>;
