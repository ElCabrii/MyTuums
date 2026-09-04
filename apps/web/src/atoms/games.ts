import { atomFamily } from "jotai-family";
import { atomWithInfiniteQuery, atomWithQuery } from "jotai-tanstack-query";
import {
  gameListQueryOptions,
  gameQueryOptions,
  type GameListParams,
} from "@/lib/query-definitions";

/**
 * The game directory's atoms (issue #314, stage 2) — one page atom per slug,
 * one list family per (sort, query) pair. The list is public data with no
 * viewer-relative field, so its family deliberately skips the sign-out sweep
 * (the `linkCardAtom` precedent); the PAGE atom carries
 * `viewerHasFavoritedGame` for the signed-in favorite button, so it is
 * registered in `session-teardown.ts` like every other viewer-owned family.
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
    // SAFETY: encode only ever writes one of the three literal sorts here.
    return { sort: key as GameListParams["sort"] };
  }
  return {
    // SAFETY: the leading segment is one of the three literal sorts by
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

/** Sweeps the viewer-owned half at sign-out — see the module doc. */
export function clearGameFamilies(): void {
  for (const key of gamePageAtomFamily.getParams()) gamePageAtomFamily.remove(key);
}
