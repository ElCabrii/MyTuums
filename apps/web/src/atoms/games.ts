import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai-family";
import {
  atomWithInfiniteQuery,
  atomWithMutation,
  atomWithQuery,
  queryClientAtom,
} from "jotai-tanstack-query";
import { store } from "@/lib/store";
import { orpc, type GamePageData } from "@/lib/orpc";
import {
  gameFavoritesQueryOptions,
  gameListQueryOptions,
  gameQueryOptions,
  type GameListParams,
} from "@/lib/query-definitions";

/**
 * The game directory's atoms (issue #314, stages 2–3): one page atom per
 * slug, one list family per (sort, query) pair, the favorite toggle, and the
 * profile rail's read.
 *
 * The LIST is public data with no viewer-relative field, so its family
 * deliberately skips the sign-out sweep (the `linkCardAtom` precedent). The
 * PAGE atom carries `viewerHasFavoritedGame`, and the favorite families hold
 * per-slug *intent* — both viewer-owned, both swept
 * (`clearGameFamilies`, registered in `session-teardown.ts`). The RAIL is
 * another user's showcase with no viewer-relative field; it skips the sweep
 * like the list does.
 */

/**
 * Encodes list params into the family key string — `postFeedFamily`'s
 * layout rule: the constrained field first, the free-text query LAST and
 * `decode`'s split consuming only the leading delimiter, so a query
 * containing `|` survives the round trip instead of being truncated.
 */
function encodeGameListParams({ sort, q }: GameListParams): string {
  const trimmed = q?.trim();
  return trimmed ? `${sort}|${trimmed}` : sort;
}

function decodeGameListParams(key: string): GameListParams {
  const separator = key.indexOf("|");
  if (separator === -1) {
    // SAFETY: encode only ever writes one of the four literal sorts here.
    return { sort: key as GameListParams["sort"] };
  }
  return {
    // SAFETY: the leading segment is one of the four literal sorts by
    // construction — the only delimiter-free keys encode() writes.
    sort: key.slice(0, separator) as GameListParams["sort"],
    q: key.slice(separator + 1),
  };
}

const gameListFamily = atomFamily((key: string) =>
  atomWithInfiniteQuery(() => gameListQueryOptions(decodeGameListParams(key))),
);

/** The infinite-query atom for one (sort, query) directory listing. */
export function gameListAtom(params: GameListParams) {
  return gameListFamily(encodeGameListParams(params));
}

/** One game's public page, shared by every component reading that slug. */
export const gamePageAtomFamily = atomFamily((slug: string) =>
  atomWithQuery(() => gameQueryOptions(slug)),
);

/** One profile's favorites rail (Q25) — covers plus names, capped server-side. */
export const gameFavoritesAtomFamily = atomFamily((username: string) =>
  atomWithQuery(() => gameFavoritesQueryOptions(username)),
);

/**
 * The state the *last* click asked for, per slug — `like.ts`'s intent
 * reasoning, verbatim: serialized responses for superseded clicks still
 * arrive, and this is how `onSuccess` drops a confirmation the user has
 * already undone instead of flickering through it.
 */
const favoriteIntentFamily = atomFamily<string, PrimitiveAtom<boolean | null>>(() =>
  atom<boolean | null>(null),
);

interface FavoriteContext {
  snapshot: GamePageSnapshot | undefined;
}

interface FavoriteResult {
  slug: string;
  favoriteCount: number;
  viewerHasFavoritedGame: boolean;
}

/** A captured `game.bySlug` cache entry — enough to undo an optimistic patch. */
interface GamePageSnapshot {
  key: readonly unknown[];
  data: GamePageData;
}

function toggleFavoriteMutationAtom(slug: string, direction: "favorite" | "unfavorite") {
  // Explicit type parameters: inference does not flow the variables/context
  // types back out through the spread of oRPC's `mutationOptions()`.
  return atomWithMutation<FavoriteResult, { slug: string }, Error, FavoriteContext>((get) => {
    const queryClient = get(queryClientAtom);
    const procedure = direction === "favorite" ? orpc.game.favorite : orpc.game.unfavorite;
    const favorited = direction === "favorite";

    return {
      ...procedure.mutationOptions(),

      // Both directions share one scope id, so a quick favorite-then-
      // unfavorite applies in click order and the UI settles on the user's
      // last intent — `like.ts`'s serialization reasoning, one game at a
      // time.
      scope: { id: `game-favorite:${slug}` },

      // Runs synchronously inside `mutate()`; nothing awaits, so cancel +
      // snapshot + patch are one atomic block. Rollback lives on the
      // mutation options (not per-call callbacks) for exactly the reason
      // `like.ts` documents: nothing ever mounts this atom's observer.
      onMutate: (): FavoriteContext => {
        const key = gameQueryOptions(slug).queryKey;
        // Cancellation is fire-and-forget (like.ts's reasoning): the
        // snapshot and patch run back-to-back below with no await between
        // them, so a refetch cannot land in that gap and poison the rollback.
        void queryClient.cancelQueries({ queryKey: key });
        const current = queryClient.getQueryData<GamePageData>(key);
        if (!current || current.viewerHasFavoritedGame === favorited) {
          return { snapshot: undefined };
        }
        queryClient.setQueryData<GamePageData>(key, {
          ...current,
          viewerHasFavoritedGame: favorited,
          favoriteCount: current.favoriteCount + (favorited ? 1 : -1),
        });
        return { snapshot: { key, data: current } };
      },

      // The pair returns the authoritative count, so success reconciles from
      // the response; the rail and the favorites-sorted listings are simply
      // invalidated — they are other queries, cheap to refetch on next view.
      onSuccess: (result: FavoriteResult) => {
        const intent = store.get(favoriteIntentFamily(slug));
        if (intent !== null && result.viewerHasFavoritedGame !== intent) return;

        const key = gameQueryOptions(slug).queryKey;
        queryClient.setQueryData<GamePageData>(key, (current) =>
          current
            ? {
                ...current,
                favoriteCount: result.favoriteCount,
                viewerHasFavoritedGame: result.viewerHasFavoritedGame,
              }
            : current,
        );
        void queryClient.invalidateQueries({ queryKey: orpc.game.favorites.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.game.list.key() });
      },

      onError: (
        _error: Error,
        _variables: { slug: string },
        context: FavoriteContext | undefined,
      ) => {
        // No snapshot means nothing was cached at `onMutate` time, so the
        // optimistic patch was a no-op and there is nothing to undo.
        if (context?.snapshot) {
          queryClient.setQueryData(context.snapshot.key, context.snapshot.data);
        }
      },
    };
  });
}

const favoriteFamily = atomFamily((slug: string) => toggleFavoriteMutationAtom(slug, "favorite"));
const unfavoriteFamily = atomFamily((slug: string) =>
  toggleFavoriteMutationAtom(slug, "unfavorite"),
);

/**
 * Write-only: `useSetAtom(toggleFavoriteAtomFamily(slug))` gives the page's
 * button the action without subscribing it to mutation status — the
 * optimistic flip is the feedback, `like.ts`'s contract.
 */
export const toggleFavoriteAtomFamily = atomFamily((slug: string) =>
  atom(null, (get) => {
    const queryClient = get(queryClientAtom);
    // Read the current state from the cache rather than a prop: a prop is a
    // render-time snapshot, so a burst of clicks would all see the same
    // starting value and resolve to the same direction.
    const favorited = queryClient.getQueryData<GamePageData>(
      gameQueryOptions(slug).queryKey,
    )?.viewerHasFavoritedGame;
    const next = !(favorited ?? false);
    store.set(favoriteIntentFamily(slug), next);
    get(next ? favoriteFamily(slug) : unfavoriteFamily(slug)).mutate({ slug });
  }),
);

/** Sweeps the viewer-owned families at sign-out — see the module doc. */
export function clearGameFamilies(): void {
  for (const key of gamePageAtomFamily.getParams()) gamePageAtomFamily.remove(key);
  for (const key of favoriteFamily.getParams()) favoriteFamily.remove(key);
  for (const key of unfavoriteFamily.getParams()) unfavoriteFamily.remove(key);
  for (const key of favoriteIntentFamily.getParams()) favoriteIntentFamily.remove(key);
  for (const key of toggleFavoriteAtomFamily.getParams()) toggleFavoriteAtomFamily.remove(key);
}
