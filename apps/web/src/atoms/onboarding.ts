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
 * Only `signUpAtom` sets it, and that is what implements "OAuth accounts don't
 * see this step" without a single conditional: the email/password path is the
 * one that runs `signUpAtom`, and it is also the only path that produces an
 * account with a password — which `authClient.twoFactor.enable` requires. A
 * social sign-up never sets the flag, claims its handle at `/welcome`, and
 * redirects to its profile exactly as before.
 *
 * `useRedirectWhenSignedIn` reads it to decide where a *complete* session goes,
 * so it stays the single owner of navigation (see the long comment in that
 * hook) — this flag changes what the app knows, not where it sends anyone.
 */
export const offerTwoFactorAtom = atom(false);
