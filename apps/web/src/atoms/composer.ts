import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { orpc } from "@/lib/orpc";
import { store } from "@/lib/store";

const STORAGE_KEY = "my-tuums.composer-draft";

/**
 * The raw persisted value. Typed `unknown` on purpose, matching
 * `feed-scope.ts`: `localStorage` is user-editable and outlives deploys, so
 * nothing read back out of it is trustworthy — `composerDraftAtom` below is
 * the only sanctioned way in.
 *
 * `getOnInit` is load-bearing for the same reason as `feed-scope.ts`:
 * without it the atom yields the initial value on the first render and the
 * stored draft only afterwards, so a half-typed post would flash empty and
 * then reappear a frame later instead of just being there.
 */
const storedComposerDraftAtom = atomWithStorage<unknown>(STORAGE_KEY, "", undefined, {
  getOnInit: true,
});

/**
 * A half-typed post, kept across navigation and reload — previously a bare
 * `useState` in `post-composer.tsx`, lost the moment the user navigated away.
 *
 * Reads collapse anything that isn't a string (a hand-edited key, or a value
 * written by a future version of the app) to `""` rather than letting it
 * reach the textarea; writes are typed, so only strings are ever stored.
 */
export const composerDraftAtom = atom(
  (get): string => {
    const stored = get(storedComposerDraftAtom);
    return typeof stored === "string" ? stored : "";
  },
  (_get, set, next: string) => {
    set(storedComposerDraftAtom, next);
  },
);

/**
 * `post.create` as a mutation atom. Unlike like/follow this has no `scope`,
 * no optimistic update, and no rollback, which is exactly why it migrates
 * first — see the commit-10 write-up for what that safely proved (and what
 * it rules out for like/follow).
 *
 * `onSuccess` can't reach `set` — `atomWithMutation`'s `getOptions` is only
 * handed a `Getter` — so the draft reset goes through the module-scope
 * `store` the same way `main.tsx` does, instead of a `set` closed over from
 * a component.
 */
export const createPostAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.post.create.mutationOptions({
    onSuccess: async () => {
      store.set(composerDraftAtom, "");
      // A new post belongs at the top of every feed it qualifies for, and
      // its position depends on server ordering — refetch rather than
      // guess where to splice it in.
      await queryClient.invalidateQueries({ queryKey: orpc.post.list.key() });
    },
  });
});
