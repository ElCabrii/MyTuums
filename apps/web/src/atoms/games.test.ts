import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";
import type { GamePageData } from "@/lib/orpc";
import { gameQueryOptions } from "@/lib/query-definitions";
import { clearGameFamilies, toggleFavoriteAtomFamily } from "@/atoms/games";

// The mock mirrors the real client's procedure tree far enough for the
// favorite atoms: the pair itself, plus the two queries `onSuccess`
// invalidates (`game.favorites`, `game.list`) — a missing group there throws
// inside every favorite mutation, exactly as like.test.ts documents for its
// own tree.
const fakeClient = {
  game: {
    bySlug: vi.fn(),
    list: vi.fn(),
    favorite: vi.fn(),
    unfavorite: vi.fn(),
    favorites: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

function makeGame(overrides: Partial<GamePageData> & { slug: string }): GamePageData {
  return {
    name: "Hades",
    summary: null,
    coverMediaPath: null,
    firstReleaseYear: 2020,
    firstReleaseDate: 1577836800,
    hypeCount: 0,
    genres: [],
    platforms: [],
    favoriteCount: 0,
    viewerHasFavoritedGame: false,
    ...overrides,
  };
}

function freshStoreWithGame(game: GamePageData) {
  const store = createStore();
  const queryClient = new QueryClient();
  store.set(queryClientAtom, queryClient);
  queryClient.setQueryData(gameQueryOptions(game.slug).queryKey, game);
  return { store, queryClient };
}

function readCachedGame(queryClient: QueryClient, slug: string): GamePageData | undefined {
  return queryClient.getQueryData<GamePageData>(gameQueryOptions(slug).queryKey);
}

describe("toggleFavoriteAtomFamily", () => {
  it("lands the optimistic patch synchronously, before the mutationFn resolves", () => {
    const { store, queryClient } = freshStoreWithGame(
      makeGame({ slug: "hades", favoriteCount: 4, viewerHasFavoritedGame: false }),
    );
    fakeClient.game.favorite.mockImplementation(() => new Promise(() => {}));

    store.set(toggleFavoriteAtomFamily("hades"));

    const patched = readCachedGame(queryClient, "hades");
    expect(patched?.viewerHasFavoritedGame).toBe(true);
    expect(patched?.favoriteCount).toBe(5);
  });

  it("rolls back a rejected mutation", async () => {
    const { store, queryClient } = freshStoreWithGame(
      makeGame({ slug: "hades", favoriteCount: 4, viewerHasFavoritedGame: false }),
    );
    fakeClient.game.favorite.mockRejectedValue(new Error("network down"));

    store.set(toggleFavoriteAtomFamily("hades"));
    expect(readCachedGame(queryClient, "hades")?.viewerHasFavoritedGame).toBe(true);

    await vi.waitFor(() => {
      expect(readCachedGame(queryClient, "hades")?.viewerHasFavoritedGame).toBe(false);
    });
    expect(readCachedGame(queryClient, "hades")?.favoriteCount).toBe(4);
  });

  it("drops a superseded response instead of flickering back", async () => {
    const { store, queryClient } = freshStoreWithGame(
      makeGame({ slug: "hades", favoriteCount: 4, viewerHasFavoritedGame: false }),
    );

    let resolveFavorite!: (value: {
      slug: string;
      favoriteCount: number;
      viewerHasFavoritedGame: boolean;
    }) => void;
    fakeClient.game.favorite.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFavorite = resolve;
        }),
    );
    fakeClient.game.unfavorite.mockImplementation(() => new Promise(() => {}));

    // Favorite, then unfavorite before the first round trip resolves.
    store.set(toggleFavoriteAtomFamily("hades"));
    store.set(toggleFavoriteAtomFamily("hades"));
    expect(readCachedGame(queryClient, "hades")?.viewerHasFavoritedGame).toBe(false);

    // The mutationFn call is deferred past a microtask boundary (the
    // synchronous-patch test above), so `resolveFavorite` only exists once
    // the promise executor has actually run.
    await vi.waitFor(() => expect(fakeClient.game.favorite).toHaveBeenCalled());
    resolveFavorite({ slug: "hades", favoriteCount: 5, viewerHasFavoritedGame: true });
    await vi.waitFor(() => {
      // The unfavorite mutation never resolves in this test, so the only
      // writer after the late confirmation would be its onSuccess — dropped.
      expect(fakeClient.game.unfavorite).toHaveBeenCalled();
    });
    expect(readCachedGame(queryClient, "hades")?.viewerHasFavoritedGame).toBe(false);
  });

  it("clearGameFamilies drops every family it owns", () => {
    const { store } = freshStoreWithGame(makeGame({ slug: "hades" }));
    store.set(toggleFavoriteAtomFamily("hades"));
    expect(toggleFavoriteAtomFamily.getParams()).toContain("hades");

    clearGameFamilies();
    expect([...toggleFavoriteAtomFamily.getParams()]).toEqual([]);
  });
});
