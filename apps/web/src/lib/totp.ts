/**
 * Reads the shared secret out of an `otpauth://` TOTP URI.
 *
 * The URI is what `twoFactor.enable` returns and what the QR code encodes; the
 * secret is its `secret` query parameter (base32, per the Key Uri Format that
 * every authenticator app implements). Deriving it here rather than asking the
 * server for it keeps the wire contract unchanged — the value is already in
 * the browser, just packed inside a string the QR renderer consumes.
 *
 * Returns `null` for anything that is not a parseable URI carrying a secret,
 * so a caller can hide the manual-entry fallback rather than offer an empty
 * one. Never logged: the string this returns IS the second factor.
 */
export function totpSecretFrom(totpURI: string): string | null {
  try {
    const secret = new URL(totpURI).searchParams.get("secret");
    return secret && secret.length > 0 ? secret : null;
  } catch {
    // `new URL` throws on a malformed URI. A missing fallback is a far better
    // outcome than a crashed enrolment panel.
    return null;
  }
}

/**
 * Groups a base32 secret into space-separated blocks of four.
 *
 * Purely presentational: a 32-character unbroken string is what makes manual
 * entry error-prone, and every authenticator app strips whitespace from a
 * pasted key. The copy action copies the *unformatted* value, so nothing
 * depends on the reader's app being tolerant.
 */
export function formatTotpSecret(secret: string): string {
  return secret.replace(/.{4}(?=.)/g, "$& ");
}
