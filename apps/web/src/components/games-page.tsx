import { useEffect, useState } from "react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Gamepad2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { GameCover } from "@/components/game-cover";
import { PaginatedState } from "@/components/paginated-state";
import { SegmentedControl, SegmentedControlItem } from "@/components/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { gameListAtom } from "@/atoms/games";
import type { GameListParams } from "@/lib/query-definitions";
import { m } from "@/paraglide/messages.js";

const routeApi = getRouteApi("/games/");

/** The sort names, in the control's display order — also the URL param's enum. */
const SORTS = ["popularity", "upcoming", "name", "year", "favorites"] as const;

/**
 * How long a keystroke may sit before the listing refilters, matching the
 * header search box's debounce — long enough to outlast a burst of typing,
 * short enough that the grid feels like it follows the input.
 */
const FILTER_DEBOUNCE_MS = 300;

/**
 * The `/games` directory index (issue #314, Q18): every game the catalog has
 * ever tracked, as a cover grid with a filter bar and five sorts.
 *
 * The sort lives in the URL (`?sort=`) so a view is shareable and the back
 * button restores it; the filter query stays component state — it is a
 * narrowing gesture, not a destination, and debouncing it into the list
 * atom's key keeps one cache entry per settled query instead of per
 * keystroke. Public: the whole page renders signed out exactly as signed in
 * (Q6) — nothing here mutates until favorites land (stage 3).
 *
 * The `upcoming` sort lists unreleased games only (TBA or future release),
 * most-wanted first by IGDB hypes — the "want" count behind the feedback
 * asking for unreleased games up front.
 */
export function GamesPage() {
  // The URL param is optional; the default lives here rather than in the
  // schema so a bare `/games` and `?sort=popularity` differ only in the URL.
  const { sort: sortParam } = routeApi.useSearch();
  const sort = sortParam ?? "popularity";
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFilter(filter.trim()), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filter]);

  const params: GameListParams = { sort };
  if (debouncedFilter) params.q = debouncedFilter;
  const listing = useAtomValue(gameListAtom(params));
  const games = listing.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
      <div className="border-border flex flex-wrap items-baseline justify-between gap-3 border-b pb-2">
        <h1 className="text-lg font-bold tracking-tight">{m.games_title()}</h1>
        <SegmentedControl label={m.games_sort_label()}>
          {SORTS.map((option) => (
            <SegmentedControlItem
              key={option}
              active={sort === option}
              onClick={() => void navigate({ to: "/games", search: { sort: option } })}
            >
              {sortLabel(option)}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>

      <div className="relative">
        <Search className="text-muted-foreground absolute top-2.5 left-2.5 h-4 w-4" />
        <Input
          type="search"
          aria-label={m.games_filter_aria()}
          placeholder={m.games_filter_placeholder()}
          className="pl-9"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <PaginatedState
        query={listing}
        errorMessage={m.feed_load_error()}
        emptyIcon={Gamepad2}
        emptyMessage={
          debouncedFilter ? m.games_filter_empty({ query: debouncedFilter }) : m.games_empty()
        }
        isEmpty={games.length === 0}
        listClassName="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
        loadingFallback={<GamesSkeleton />}
      >
        {games.map((game) => (
          <Link
            key={game.igdbId}
            to="/games/$slug"
            params={{ slug: game.slug }}
            className="group focus-visible:ring-ring block overflow-hidden rounded-lg focus-visible:ring-2 focus-visible:outline-none"
          >
            <div className="bg-muted relative aspect-[2/3] overflow-hidden rounded-lg">
              <GameCover
                cover={game.coverMediaPath}
                name={game.name}
                sizes="(min-width: 1024px) 180px, (min-width: 768px) 220px, 45vw"
                className="transition-transform group-hover:scale-105 motion-reduce:transition-none"
              />
            </div>
            <p className="text-foreground mt-1.5 truncate text-sm font-medium">{game.name}</p>
            {sort === "upcoming" ? (
              <p className="text-muted-foreground text-xs">
                {game.hypeCount === 1
                  ? m.game_hype_count_one({ count: game.hypeCount })
                  : m.game_hype_count_many({ count: game.hypeCount })}
                {game.firstReleaseYear !== null ? ` · ${game.firstReleaseYear}` : ""}
              </p>
            ) : (
              game.firstReleaseYear !== null && (
                <p className="text-muted-foreground text-xs">{game.firstReleaseYear}</p>
              )
            )}
          </Link>
        ))}
      </PaginatedState>
    </div>
  );
}

/**
 * Ten placeholder cards that mirror the directory's cover grid (cover +
 * name + year) while the listing loads.
 *
 * `aria-hidden`: it paints structure, not information.
 */
export function GamesSkeleton() {
  return (
    <div
      aria-hidden
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
    >
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((card) => (
        <div key={card}>
          <Skeleton className="aspect-[2/3] w-full rounded-lg motion-reduce:animate-none" />
          <Skeleton className="mt-1.5 h-4 w-3/4 motion-reduce:animate-none" />
          <Skeleton className="mt-1 h-3 w-1/4 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

function sortLabel(sort: (typeof SORTS)[number]): string {
  switch (sort) {
    case "popularity":
      return m.games_sort_popularity();
    case "upcoming":
      return m.games_sort_upcoming();
    case "name":
      return m.games_sort_name();
    case "year":
      return m.games_sort_year();
    case "favorites":
      return m.games_sort_favorites();
  }
}
