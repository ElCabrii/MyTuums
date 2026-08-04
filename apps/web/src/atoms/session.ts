import { atom } from "jotai";
import { atomEffect } from "jotai-effect";
import { sessionStore } from "@/lib/auth-client";
import { handleOf } from "@/lib/user";

/**
 * The bridge from BetterAuth's nanostore into the atom graph. Seeded from
 * `.get()` — which nanostores guarantees is always initialized, subscribers
 * or not — so there is no `null`-then-real-value flash on first read.
 *
 * `onMount` runs once something actually reads this atom, mirroring the
 * nanostore's own lifecycle: `sessionStore.subscribe` calls its listener
 * immediately with the current value (unlike `.listen`, which only fires on
 * change), so re-`set`ting from it here can't reintroduce the gap `.get()`
 * already closed — it just keeps the atom in sync afterwards. Returning the
 * unsubscribe is what stops every mount from leaking another listener onto
 * the shared nanostore, the same reason `theme.ts`'s `systemThemeAtom` does.
 */
export const sessionAtom = atom(sessionStore.get());

sessionAtom.onMount = (set) => sessionStore.subscribe(set);

/**
 * The derived atoms below exist so a component reading one boolean re-renders
 * only when that boolean flips. `useSession()` hands back a new object
 * identity on every fetch/refetch — `PostCard` alone renders one per feed
 * item, so N cards means N nanostore subscriptions all firing on any session
 * change, even one that doesn't affect what they show.
 */

export const viewerAtom = atom((get) => get(sessionAtom).data?.user ?? null);

export const isSignedInAtom = atom((get) => get(viewerAtom) !== null);

export const viewerIdAtom = atom((get) => get(viewerAtom)?.id);

export const viewerHandleAtom = atom((get) => handleOf(get(viewerAtom)));

export const sessionPendingAtom = atom((get) => get(sessionAtom).isPending);

/**
 * The latch behind the app's splash screen: "the first `/get-session` has
 * landed". `false` exactly while the cold-load fetch is in flight, `true`
 * from then on — and it never flips back.
 *
 * The latch exists because `sessionPendingAtom` is the wrong key for a
 * splash, even though it reads "pending" at cold load. `fetchSession` sets
 * `isPending: current.data === null` on EVERY fetch (better-auth's
 * client/session-atom.mjs), and a successful `/sign-in/email` flips the
 * `$sessionSignal` → a refetch while `data` is still null → `isPending` true
 * again. Keying a full-screen splash on the raw flag would drop it over the
 * login form mid-sign-in. So this latches on the *first* resolution and
 * stays put; it is not reset on sign-out, because one splash per document
 * load is the whole point.
 *
 * A failed fetch is safe either way: the client only flips `$sessionSignal`
 * from `onSuccess` (client/proxy.mjs), and an errored cold load settles the
 * latch through the `catch` path that still clears `isPending`.
 *
 * A latch is state, and in this app state that outlives a render lives in an
 * atom — but it cannot be a plain derived atom (nothing would ever set it
 * true), so it is an `atomEffect` per the codebase rule that reactions to
 * atom changes belong in effects, not `useState`.
 */
const sessionSettledStateAtom = atom(false);

export const sessionSettledEffect = atomEffect((get, set) => {
  if (get(sessionPendingAtom)) return;
  set(sessionSettledStateAtom, true);
  // The splash is static markup in index.html so it paints before the bundle
  // loads; this is what removes it the moment the first session lands. `?.`
  // — nothing to remove in tests, or on a second run of the effect.
  document.getElementById("app-splash")?.remove();
});

export const sessionSettledAtom = atom((get) => get(sessionSettledStateAtom));

/**
 * A signed-in account that has no handle yet — the state an OAuth sign-up
 * lands in, and the one this app cannot render.
 *
 * The `username` plugin leaves `user.username` null on social sign-up and
 * offers no way to generate one, but every profile URL, follow list and
 * `user.byUsername` lookup keys on that column. Such an account has no profile
 * page, cannot be followed, and used to fall through `header.tsx`'s
 * `user && handle` branch into rendering "Log in"/"Register" *while signed in*.
 *
 * So it is treated as an incomplete sign-up rather than a valid state:
 * `use-require-handle.ts` sends these sessions to `/welcome` until they claim
 * one. Reading it as a derived atom rather than re-deriving `!handle` at each
 * call site is what keeps the header, the redirect and the gate from
 * disagreeing about what "incomplete" means.
 */
export const needsHandleAtom = atom((get) => get(isSignedInAtom) && !get(viewerHandleAtom));

/**
 * A signed-in account that has never declared a date of birth — a social
 * sign-up that skipped it, or an account that predates the 15+ rule.
 *
 * The rule itself lives in `packages/auth/src/dob.ts` (server) and
 * `lib/auth-validation.ts` (client); this atom exists because the *absence*
 * of a declaration is a completeness state, exactly like a missing handle:
 * the app holds such sessions at `/welcome` until they declare one. Sharing
 * the definition through one derived atom is what keeps the gate, the header
 * and the redirect from disagreeing about what "complete" means.
 */
export const viewerDateOfBirthAtom = atom((get) => get(viewerAtom)?.dateOfBirth ?? null);

export const needsDobAtom = atom((get) => get(isSignedInAtom) && !get(viewerDateOfBirthAtom));

/**
 * The whole definition of an incomplete sign-up, so the gate and the `/welcome`
 * page check the same thing. `use-require-handle.ts` gates on this rather than
 * `needsHandleAtom` directly.
 */
export const needsCompletionAtom = atom((get) => get(needsHandleAtom) || get(needsDobAtom));
