import { atom } from "jotai";
import { sessionStore } from "@/lib/auth-client";
import { handleOf, initialsOf } from "@/lib/user";

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

export const viewerInitialsAtom = atom((get) => initialsOf(get(viewerAtom)?.name));

export const sessionPendingAtom = atom((get) => get(sessionAtom).isPending);
