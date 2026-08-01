import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";
import type { WritableAtom } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    usernameClient(),
  ],
});

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
 */
export const sessionStore = authClient.$store.atoms.session as WritableAtom<
  ReturnType<typeof useSession>
>;
