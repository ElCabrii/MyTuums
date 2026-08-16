import { createAuthClient } from "better-auth/react";
import { lastLoginMethodClient, twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import type { WritableAtom } from "better-auth/react";

/**
 * Google's client id, exposed to the browser.
 *
 * One Tap runs Google's script in the page, so unlike every other OAuth
 * provider its client id has to reach the bundle — hence the `VITE_` prefix.
 * It is a public identifier, not a secret; the matching `GOOGLE_CLIENT_SECRET`
 * stays server-side and never appears here.
 *
 * Empty when unconfigured, which is what `shouldOfferOneTap` below tests. It is
 * exported so call sites can skip the prompt rather than watching Google's
 * script fail silently.
 */
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

/** True when a `VITE_GOOGLE_CLIENT_ID` is configured — the on/off switch for the One Tap prompt. */
export let shouldOfferOneTap = googleClientId !== "";

export const realAuthClient = createAuthClient({
  /**
   * A static array of plugins that each satisfy `BetterAuthClientPlugin`
   * exactly, and it has to stay that way.
   *
   * Better Auth infers this whole client's surface from the array's element
   * type. The moment one element widens that union — a conditional spread, or
   * a cast to the base interface — inference collapses and `signIn.email`,
   * `passkey.listUserPasskeys`, even `session.user.username` all disappear at
   * once, with errors pointing at the call sites rather than at the array.
   *
   * That is exactly why Google One Tap is NOT here. Its client plugin's
   * `getActions` signature does not satisfy `BetterAuthClientPlugin` in
   * 1.6.25 (its `$fetch` parameter is narrower than the interface's), and
   * casting it in place took the other four plugins' types down with it. It
   * lives behind its own client in ./one-tap.ts instead.
   */
  plugins: [
    usernameClient(),

    /**
     * Deliberately without `onTwoFactorRedirect`.
     *
     * Both ways of handling the challenge that the plugin offers are wrong
     * here: `twoFactorPage` does a full document reload, which throws away the
     * Jotai store mid-sign-in, and `onTwoFactorRedirect` fires from inside a
     * module that cannot reach the router without cycling through `main.tsx`.
     *
     * Instead `signInAtom` (src/atoms/auth.ts) reports the challenge back to
     * its caller as a value, and the route navigates. Navigation stays in the
     * component layer where the router already lives, which is the same
     * division `use-redirect-when-signed-in.ts` documents.
     */
    twoFactorClient(),

    passkeyClient(),
    lastLoginMethodClient(),
  ],
});

/** The client's React hook and action functions, re-exported as live bindings so the test seam below can swap them. */
export let authClient = realAuthClient;
export let useSession = realAuthClient.useSession;
export let signIn = realAuthClient.signIn;
export let signUp = realAuthClient.signUp;
export let signOut = realAuthClient.signOut;

/**
 * BetterAuth's session lives in a nanostore (`$store.atoms.session`), not
 * React state — `useSession` above is just `useStore(sessionStore)`. `atoms`
 * is typed `Record<string, WritableAtom<any>>` because it also holds every
 * plugin's atoms, so the specific value type is lost at that boundary. This
 * cast happens exactly once, here, so `src/atoms/session.ts` (and everything
 * downstream of it) never touches `any`. The value type is pulled from
 * `useSession`'s return rather than hand-written, so a BetterAuth upgrade
 * that changes the session shape surfaces as a type error here instead of
 * silently drifting.
 *
 * The intersection is the one hand-written piece, and it exists because
 * better-auth 1.6.25's client types never surface `user.additionalFields`:
 * `InferUserFromClient` reads plugin schemas only, so every field the server
 * declares in `packages/auth/src/index.ts` arrives here untyped. They are typed
 * once, at this boundary, rather than cast at each of the dozen call sites that
 * read them.
 *
 * `dateOfBirth` is what the 15+ gate reads; at runtime the session store
 * carries it as an ISO string (JSON round trip) or a Date (in-process), so both
 * are covered. The rest are the editable profile and the stored theme/language
 * defaults — all nullable, because an account that has never set one has none,
 * which is exactly the state `atoms/theme.ts` and `atoms/locale.ts` fall back
 * from.
 *
 * These are deliberately typed loosely as `string | null` rather than as the
 * `Theme`/`Locale` unions: the values come off the wire, and the atoms that
 * consume them already sanitise on read for precisely that reason.
 */
type SessionWithDeclaredFields = ReturnType<typeof useSession> & {
  data: {
    user: {
      dateOfBirth: Date | string | null;
      bio: string | null;
      bannerImage: string | null;
      themePreference: string | null;
      localePreference: string | null;
      // The moderation system's role and ban fields (issue #38), typed off
      // the wire exactly like the additionalFields above: the admin plugin's
      // schema reaches this client only as JSON. `role` defaults to "user"
      // on every account; the ban trio is false/null until a moderator acts.
      // `atoms/session.ts` sanitises role on read — never trust the wire.
      role: string | null;
      banned: boolean;
      banExpires: Date | string | null;
      banReason: string | null;
    };
  } | null;
};

// SAFETY: the additionalFields above exist on the server's user schema but
// reach this client only as JSON, so the session atom is declared with them.
/** The session-store contract `atoms/session.ts` reads: get + nanostore-style subscribe. */
export interface SessionStore {
  get(): SessionWithDeclaredFields;
  subscribe(listener: (value: SessionWithDeclaredFields) => void): () => void;
}

export let sessionStore: SessionStore =
  // SAFETY: the additionalFields above exist on the server's user schema but
  // reach this client only as JSON, so the session atom is declared with them.
  realAuthClient.$store.atoms.session as WritableAtom<SessionWithDeclaredFields>;

/** Providers this app knows how to render, in display order. */
const KNOWN_SOCIAL_PROVIDERS = [
  { id: "google", label: "Google" },
  { id: "discord", label: "Discord" },
  { id: "twitch", label: "Twitch" },
] as const;

/** The id of any provider this app knows how to render a button for. */
export type SocialProviderId = (typeof KNOWN_SOCIAL_PROVIDERS)[number]["id"];

/**
 * The OAuth providers this build offers, in display order.
 *
 * The server registers a provider only when it holds both halves of that
 * provider's credentials (packages/auth/src/social.ts) — but the browser cannot
 * see server environment, and the client ids of Discord and Twitch have no
 * business in the bundle. So the on/off decision is mirrored through one
 * comma-separated `VITE_SOCIAL_PROVIDERS` variable rather than a `VITE_` copy
 * of each credential.
 *
 * It is one variable rather than three flags so the two lists are obviously
 * meant to agree, and unknown entries are dropped rather than rendered: a typo
 * yields no button instead of one that dead-ends at "provider not found" after
 * the person has already left the site.
 */
export interface SocialProvider {
  id: SocialProviderId;
  label: string;
}

export let socialProviders: readonly SocialProvider[] = (() => {
  const enabled = new Set(
    (import.meta.env.VITE_SOCIAL_PROVIDERS ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );

  return KNOWN_SOCIAL_PROVIDERS.filter((provider) => enabled.has(provider.id));
})();

/** The `{ data, error }` pair every BetterAuth client action resolves with. */
export interface AuthClientResult {
  data: unknown;
  error: unknown;
}

/** A recording stand-in for one client action — vi.fn implementations satisfy this directly. */
export type AuthClientAction = (...args: never[]) => Promise<AuthClientResult>;

/** The client surface the app reaches for — declared so test harnesses can substitute a recording fake. */
export interface AuthClientSurface {
  signIn?: {
    email?: AuthClientAction;
    username?: AuthClientAction;
    social?: AuthClientAction;
    passkey?: AuthClientAction;
  };
  signUp?: { email?: AuthClientAction };
  signOut?: AuthClientAction;
  requestPasswordReset?: AuthClientAction;
  resetPassword?: AuthClientAction;
  updateUser?: AuthClientAction;
  changePassword?: AuthClientAction;
  listAccounts?: AuthClientAction;
  linkSocial?: AuthClientAction;
  unlinkAccount?: AuthClientAction;
  twoFactor?: {
    enable?: AuthClientAction;
    disable?: AuthClientAction;
    verifyTotp?: AuthClientAction;
    verifyOtp?: AuthClientAction;
    verifyBackupCode?: AuthClientAction;
    sendOtp?: AuthClientAction;
  };
  passkey?: {
    addPasskey?: AuthClientAction;
    listUserPasskeys?: AuthClientAction;
    updatePasskey?: AuthClientAction;
    deletePasskey?: AuthClientAction;
  };
  getLastUsedLoginMethod?: () => string | null;
}

export type UseSessionHook = typeof realAuthClient.useSession;

export interface TestAuthClientOverrides {
  authClient?: AuthClientSurface;
  sessionStore?: unknown;
  useSession?: UseSessionHook;
  signIn?: typeof realAuthClient.signIn;
  signUp?: typeof realAuthClient.signUp;
  signOut?: typeof realAuthClient.signOut;
  shouldOfferOneTap?: boolean;
  socialProviders?: readonly SocialProvider[];
}

/**
 * Test-only seam: swaps the module's live exports for a harness's fakes.
 * Production never calls this — every consumer keeps importing the same names,
 * and ESM live bindings deliver whatever the harness installed.
 */
export function installTestAuthClient(overrides: TestAuthClientOverrides): void {
  if (overrides.authClient) {
    // SAFETY: the fake implements the app's surface by contract; the inferred
    // better-auth client type is wider than the seam needs to express.
    authClient = overrides.authClient as typeof realAuthClient;
  }
  if (overrides.sessionStore) {
    // SAFETY: test fakes push partial session fixtures; the seam trusts the suite
    // to feed the shape the atoms read.
    sessionStore = overrides.sessionStore as SessionStore;
  }
  if (overrides.useSession) useSession = overrides.useSession;
  if (overrides.signIn) signIn = overrides.signIn;
  if (overrides.signUp) signUp = overrides.signUp;
  if (overrides.signOut) signOut = overrides.signOut;
  if (overrides.shouldOfferOneTap !== undefined) shouldOfferOneTap = overrides.shouldOfferOneTap;
  if (overrides.socialProviders) socialProviders = overrides.socialProviders;
}
