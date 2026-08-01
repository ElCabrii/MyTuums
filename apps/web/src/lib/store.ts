import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { queryClient } from "@/lib/query-client";

/**
 * The single Jotai store for the app, hydrated with the single `QueryClient`
 * at MODULE SCOPE — not via `useHydrateAtoms` in a component.
 *
 * `queryClientAtom` (from `jotai-tanstack-query`) defaults to its own
 * `new QueryClient()`. `useHydrateAtoms` only applies its initial values on
 * the very first render of the component that calls it, so any read of the
 * atom that happens before that render — a router loader, a `store.get()` in
 * an event handler, a test that imports the atom directly — observes the
 * package's default client first and locks it in; jotai will not
 * re-initialise an atom that already has a value. Setting it here, before
 * anything else touches the store, means there is no window in which the
 * default can be observed.
 *
 * Two `QueryClient`s means two `MutationCache`s. `MutationCache.#scopes` is a
 * private instance field, so an atom-driven mutation and a hook-driven
 * mutation sharing the same `scope.id` would silently stop serialising
 * against each other if they ended up on different clients — no error, no
 * type failure, just a UI that looks correct until two mutations that must
 * run in order run concurrently instead.
 */
export const store = createStore();
store.set(queryClientAtom, queryClient);
