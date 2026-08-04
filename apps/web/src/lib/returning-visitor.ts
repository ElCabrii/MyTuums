/**
 * A first-party "this device has had a session" flag.
 *
 * Google One Tap is a returning-user accelerator — its own abuse policy
 * discourages prompting brand-new visitors, and prompting someone with no
 * Google session also makes the GSI script log an error for every anonymous
 * visit. But the server's session cookie is httpOnly, so `document.cookie`
 * cannot see it; the app stamps this cookie itself the moment a session
 * first appears (see `session.ts`, the one place every sign-in path
 * converges). It is a per-device preference flag, like the stored theme and
 * locale — not a security boundary, and not a replacement for the server's
 * session.
 */
export const RETURNING_VISITOR_COOKIE = "mytuums_returning";

export function isReturningVisitor(): boolean {
  return document.cookie
    .split("; ")
    .some((part) => part.startsWith(`${RETURNING_VISITOR_COOKIE}=`));
}

export function stampReturningVisitor(): void {
  // Year-long, like the app's stored theme/locale overrides. SameSite=Lax so
  // the flag is never sent with cross-site requests.
  document.cookie = `${RETURNING_VISITOR_COOKIE}=1; max-age=31536000; path=/; SameSite=Lax`;
}
