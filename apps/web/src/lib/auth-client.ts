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
export const shouldOfferOneTap = googleClientId !== "";

export const authClient = createAuthClient({
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

/** The client's React hook and action functions, re-exported for convenience. */
export const { useSession, signIn, signUp, signOut } = authClient;

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

export const sessionStore = authClient.$store.atoms
  .session as WritableAtom<SessionWithDeclaredFields>;

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
export const socialProviders = (() => {
  const enabled = new Set(
    (import.meta.env.VITE_SOCIAL_PROVIDERS ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );

  return KNOWN_SOCIAL_PROVIDERS.filter((provider) => enabled.has(provider.id));
})();
