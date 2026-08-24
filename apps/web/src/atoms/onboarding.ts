import { atom } from "jotai";

/**
 * Whether the person who just signed up should be offered two-factor before
 * being dropped on their profile.
 *
 * In memory only, deliberately — not `atomWithStorage`. It is a one-shot for
 * the sign-up currently in progress, and persisting it would mean a closed tab
 * mid-flow resurrects the offer days later on a page nobody expected it on.
 * The cost of losing it to a refresh is that the offer is skipped, which is the
 * same outcome as declining it; the cost of persisting it wrongly is a modal
 * gate on an established account.
 *
 * `useRedirectWhenSignedIn` reads it to decide where a *complete* session goes,
 * so it stays the single owner of navigation (see the long comment in that
 * hook) — this flag changes what the app knows, not where it sends anyone.
 *
 * NOTE (issue #172): nothing raises this flag any more (`signOutAtom` still
 * clears it, so a stale offer cannot outlive a session). A password sign-up no
 * longer creates a session — `requireEmailVerification` holds it back until
 * the email is verified, and verification happens in a separate browser
 * session (the email link), so an in-memory flag set at sign-up cannot survive
 * to the session that follows. The automatic post-signup 2FA offer is
 * therefore dormant on the password path; 2FA remains reachable from settings.
 * The flag and its readers are left in place rather than ripped out here,
 * because re-offering 2FA after verification is a separate product decision
 * (persist the intent, or prompt on first verified sign-in), not part of the
 * email-verification gate. A social sign-up never set the flag and still
 * claims its handle at `/welcome` exactly as before.
 */
export const offerTwoFactorAtom = atom(false);
