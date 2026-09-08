import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { useEffect, useRef, useState } from "react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Compass, Search, SlidersHorizontal, X } from "lucide-react";
import { RankedFeed } from "@/components/ranked-feed";
import { GameCover } from "@/components/game-cover";
import { Input } from "@/components/ui/input";
import type { PostFeedParams } from "@/atoms/post-feed";
import { gameListAtom } from "@/atoms/games";
import { gamePageAtomFamily } from "@/atoms/games";
import { m } from "@/paraglide/messages.js";

const routeApi = getRouteApi("/discover");

/** Discover's URL params — the feed filters, shareable and back-button safe. */
interface DiscoverSearch {
  q?: string;
  game?: string;
}

/**
 * How long a keystroke may sit before the URL (and with it the listing)
 * refilters, matching the game directory's filter bar — long enough to
 * outlast a burst of typing, short enough that the feed feels like it
 * follows the input. The URL is the source of truth (`?q=`, `?game=`), so a
 * filtered view is shareable and the back button restores it; inputs edit
 * local state and debounce-navigate with `replace` so typing never spams
 * history.
 */
const FILTER_DEBOUNCE_MS = 300;

/**
 * The Discover page (route `/discover`): ranked top-level posts from other
 * authors, including followed accounts, plus the search box and
 * game filter the feedback asked for, and the Who-to-Follow module above the
 * posts.
 *
 * Both filters compose as AND through `post.list`'s `q` + `gameSlug` (the
 * game slug resolves server-side to its hashtag key and matches `#key` in
 * post text, the same substring rule the `#tag` search link uses). A hashtag
 * click lands here as `?game=slug`; the game picker below writes the same
 * param. Deliberately no composer and no scope tabs — the header's post
 * button is where writing happens.
 *
 * Reachable only signed in: the session gate plus the server page gate (the
 * path is absent from `SIGNED_OUT_PATHS`).
 */
export function DiscoverPage() {
  const { q: urlQ, game: urlGame } = routeApi.useSearch();
  const navigate = useNavigate();
  const trimmedQ = urlQ?.trim() ? urlQ.trim() : undefined;
  const trimmedGame = urlGame?.trim() ? urlGame.trim() : undefined;
  const isFiltered = Boolean(trimmedQ ?? trimmedGame);

  const [qInput, setQInput] = useState(urlQ ?? "");
  const [gameInput, setGameInput] = useState("");
  const [debouncedGameInput, setDebouncedGameInput] = useState("");
  const [gamePickerOpen, setGamePickerOpen] = useState(false);
  const qTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Back/forward and hashtag clicks rewrite the URL under the inputs — the
  // inputs follow it rather than own it. Adjusted during render (not in an
  // effect): when the URL's `q` moves under an editing input, the input
  // resets to it; typing itself never changes `urlQ` synchronously, so this
  // never fights the keystroke handler below.
  const [lastUrlQ, setLastUrlQ] = useState(urlQ);
  if (urlQ !== lastUrlQ) {
    setLastUrlQ(urlQ);
    setQInput(urlQ ?? "");
  }
  const [lastUrlGame, setLastUrlGame] = useState(trimmedGame);
  if (trimmedGame !== lastUrlGame) {
    setLastUrlGame(trimmedGame);
    if (!trimmedGame) {
      setGameInput("");
      setDebouncedGameInput("");
      setGamePickerOpen(false);
    }
  }

  useEffect(() => () => clearTimeout(qTimer.current), []);
  useEffect(() => () => clearTimeout(gameTimer.current), []);

  function pushSearch(next: DiscoverSearch) {
    const search: DiscoverSearch = {};
    if (next.q) search.q = next.q;
    if (next.game) search.game = next.game;
    void navigate({ to: "/discover", search, replace: true });
  }

  function onQChange(value: string) {
    setQInput(value);
    clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => {
      const nextQ = value.trim();
      if ((nextQ || undefined) === trimmedQ) return;
      pushSearch({ q: nextQ || undefined, game: trimmedGame });
    }, FILTER_DEBOUNCE_MS);
  }

  function onGameInputChange(value: string) {
    setGameInput(value);
    clearTimeout(gameTimer.current);
    gameTimer.current = setTimeout(() => setDebouncedGameInput(value.trim()), FILTER_DEBOUNCE_MS);
  }

  function selectGame(slug: string) {
    clearTimeout(gameTimer.current);
    setGameInput("");
    setDebouncedGameInput("");
    setGamePickerOpen(false);
    pushSearch({ q: trimmedQ, game: slug });
  }

  function clearFilters() {
    clearTimeout(qTimer.current);
    clearTimeout(gameTimer.current);
    setQInput("");
    setGameInput("");
    setDebouncedGameInput("");
    setGamePickerOpen(false);
    pushSearch({});
  }

  const feedParams: PostFeedParams = { feed: "discover", ranked: true };
  if (trimmedQ) feedParams.q = trimmedQ;
  if (trimmedGame) feedParams.gameSlug = trimmedGame;

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
      <div className="border-border flex items-baseline justify-between gap-3 border-b pb-2">
        <h1 className="text-lg font-bold tracking-tight">{m.nav_discover()}</h1>
        {isFiltered && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-link hover:text-link/80 text-sm font-medium underline underline-offset-2"
          >
            {m.discover_clear_filters()}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground absolute top-3.5 left-3 size-4" />
          <Input
            type="search"
            aria-label={m.discover_search_aria()}
            placeholder={m.discover_search_placeholder()}
            className="h-11 pl-9"
            value={qInput}
            onChange={(event) => onQChange(event.target.value)}
          />
        </div>
        <Popover open={gamePickerOpen} onOpenChange={setGamePickerOpen}>
          <PopoverTrigger render={<Button variant="outline" className="h-11 shrink-0 gap-2" />}>
            <SlidersHorizontal className="size-4" />
            {m.discover_filters()}
            {trimmedGame && (
              <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs">
                1
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="max-h-[min(32rem,var(--available-height))] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain"
          >
            <PopoverTitle>{m.discover_filters()}</PopoverTitle>
            <div className="space-y-2">
              <label htmlFor="discover-game-filter" className="text-sm font-medium">
                {m.discover_game_filter_aria()}
              </label>
              <Input
                id="discover-game-filter"
                type="search"
                placeholder={m.discover_game_filter_placeholder()}
                value={gameInput}
                onChange={(event) => onGameInputChange(event.target.value)}
              />
              <GamePickerList query={debouncedGameInput} onSelect={selectGame} />
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {trimmedGame && (
        <ActiveGameChip slug={trimmedGame} onRemove={() => pushSearch({ q: trimmedQ })} />
      )}

      <RankedFeed
        params={feedParams}
        emptyMessage={isFiltered ? m.discover_filtered_empty() : m.discover_empty()}
        emptyIcon={Compass}
        suggestions="discover"
      />
    </div>
  );
}

/** The active `?game=` filter as a chip — the game's name with a remove button. */
function ActiveGameChip({ slug, onRemove }: { slug: string; onRemove: () => void }) {
  const game = useAtomValue(gamePageAtomFamily(slug));
  const name = game.data?.name ?? slug;

  return (
    <div className="border-border bg-muted/40 flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <Link
        to="/games/$slug"
        params={{ slug }}
        className="text-link hover:text-link/80 min-w-0 truncate text-sm font-medium underline underline-offset-2"
      >
        {m.discover_game_chip({ name })}
      </Link>
      <button
        type="button"
        onClick={onRemove}
        aria-label={m.discover_game_chip_remove({ name })}
        className="text-muted-foreground hover:text-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The game picker's dropdown — top matches for the debounced input, popularity-first. */
function GamePickerList({ query, onSelect }: { query: string; onSelect: (slug: string) => void }) {
  const listing = useAtomValue(gameListAtom({ sort: "popularity", q: query }));
  const games = listing.data?.pages.flatMap((page) => page.items).slice(0, 5) ?? [];

  if (listing.isPending)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {m.discover_filters_loading()}
      </p>
    );
  if (listing.isError)
    return (
      <p role="alert" className="text-destructive text-sm">
        {m.search_load_error()}
      </p>
    );
  if (games.length === 0)
    return <p className="text-muted-foreground text-sm">{m.search_no_results({ query })}</p>;

  return (
    <ul aria-label={m.discover_game_filter_aria()} className="space-y-1">
      {games.map((game) => (
        <li key={game.igdbId}>
          <button
            type="button"
            aria-label={game.name}
            onClick={() => onSelect(game.slug)}
            className="hover:bg-muted focus-visible:ring-ring flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-2"
          >
            <span className="bg-muted h-10 w-8 shrink-0 overflow-hidden rounded">
              <GameCover cover={game.coverMediaPath} name={game.name} sizes="32px" />
            </span>
            <span className="min-w-0">
              <span className="text-foreground block truncate text-sm font-medium">
                {game.name}
              </span>
              {game.firstReleaseYear !== null && (
                <span className="text-muted-foreground block text-xs">{game.firstReleaseYear}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
