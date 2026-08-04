import { sessionStore } from "@/lib/auth-client";

type SessionValue = ReturnType<typeof sessionStore.get>;

/**
 * Resolves once BetterAuth's session store satisfies `predicate`.
 *
 * Several BetterAuth client calls resolve *before* the session they changed is
 * visible. `signOut()` and `updateUser()` both trigger a separate, un-awaited
 * `/get-session` refetch, so for a moment afterwards `sessionAtom` still holds
 * the previous value and everything derived from it — `isSignedInAtom`,
 * `viewerHandleAtom`, `needsHandleAtom` — is confidently stale.
 *
 * That gap is not theoretical. It is the bug `e2e/tests/specs/auth.spec.ts`
 * documented: sign out, navigate to `/login`, and `useRedirectWhenSignedIn`
 * reads a still-`true` `isSignedInAtom` and bounces you straight back to the
 * profile you just left. The same shape would break claiming a handle, where
 * `useRequireHandle` would return you to `/welcome` moments after you left it.
 *
 * `subscribe` fires immediately with the current value, so a store that already
 * satisfies the predicate resolves without waiting a frame.
 *
 * The timeout is a ceiling, not a hope. If the refetch hangs, the caller must
 * still be able to finish and navigate — a slow confirmation is a far better
 * failure than a button that never releases. It resolves rather than rejects
 * because by this point the *server* state has already changed; only our view
 * of it is late.
 */
export function waitForSession(
  predicate: (value: SessionValue) => boolean,
  timeoutMs = 3000,
): Promise<void> {
  // Checked up front, and this is what makes the rest safe. `subscribe` calls
  // its listener synchronously with the current value, so without this early
  // return `finish` could run *during* the `subscribe` call below — before
  // `unsubscribe` exists to be called. Returning here means the immediate
  // listener call is guaranteed not to satisfy the predicate, because it
  // receives the very value just rejected.
  if (predicate(sessionStore.get())) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = sessionStore.subscribe((value) => {
      if (predicate(value)) finish();
    });
  });
}

/** The session store reports nobody signed in. */
export const waitForSignedOut = (): Promise<void> => waitForSession((value) => !value.data);

/** The signed-in user now carries a handle — used after claiming one at `/welcome`. */
export const waitForHandle = (): Promise<void> =>
  waitForSession((value) => Boolean(value.data?.user.username));

/**
 * The signed-in user is now a complete sign-up: handle *and* date of birth.
 * Used after the `/welcome` claim, which can set either or both in one
 * `updateUser` call.
 */
export const waitForCompletion = (): Promise<void> =>
  waitForSession(
    (value) => Boolean(value.data?.user.username) && Boolean(value.data?.user.dateOfBirth),
  );

/**
 * Forces the session store to refetch, and waits for it to carry the result.
 *
 * The `waitFor*` helpers above all wait out a refetch something else already
 * started — `updateUser` fires one itself, and they just outlast it. This has
 * nothing to outlast: `user.uploadImage` writes the row with Drizzle, straight
 * past Better Auth, so the client has no idea anything changed.
 *
 * The refetch goes through the store's own `refetch` (the atom's `fetchSession`,
 * better-auth's `client/session-atom.mjs`) — the code path that actually writes
 * the nanostore, which `sessionAtom` mirrors. **`authClient.getSession()` is
 * deliberately not used, and that is not obvious:** it fetches and resolves
 * with fresh data, but it does not touch the store, so `sessionAtom` and
 * everything derived from it stay exactly as stale as before. The store is
 * only refetched when `$sessionSignal` flips, and the client flips it for a
 * fixed list of paths (`/update-user`, `/sign-in/*`, `/change-password`, …)
 * that `/get-session` is deliberately not on — see `atomListeners` in
 * better-auth's `client/config.mjs`. Calling `getSession` and waiting for the
 * store to change therefore waits forever, which showed up as an avatar that
 * uploaded successfully and never appeared.
 *
 * `disableCookieCache: true` is a no-op today — `session.cookieCache` is
 * deliberately off, because the cached `get-session` path serves without
 * re-validating the session token against the database and that breaks
 * `revokeSessionsOnPasswordReset` (see packages/auth/src/index.ts) — but it
 * is load-bearing for the day someone enables it: a Drizzle write is exactly
 * the case that cookie does not know about, and this is the one client call
 * that must read the row rather than the cache (`api/routes/session.mjs`
 * gates the cookie path on `ctx.query?.disableCookieCache`). Keep it.
 */
export async function refreshSession(): Promise<void> {
  await sessionStore.get().refetch({ query: { disableCookieCache: true } });
}
