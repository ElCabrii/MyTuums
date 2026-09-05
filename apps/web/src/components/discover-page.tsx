import { useEffect, useRef, useState } from "react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Compass, Search, X } from "lucide-react";
import { PostFeed } from "@/components/post-feed";
import { GameCover } from "@/components/game-cover";
import { Input } from "@/components/ui/input";
import { postFeedAtom, type PostFeedParams } from "@/atoms/post-feed";
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
 * The Discover page (route `/discover`): recent top-level posts from everyone,
 * newest first — the out-of-network reading surface — plus the search box and
 * game filter the feedback asked for.
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
    setGamePickerOpen(true);
    clearTimeout(gameTimer.current);
    gameTimer.current = setTimeout(() => setDebouncedGameInput(value.trim()), FILTER_DEBOUNCE_MS);
  }

  function selectGame(slug: string) {
    setGameInput("");
    setDebouncedGameInput("");
    setGamePickerOpen(false);
    pushSearch({ q: trimmedQ, game: slug });
  }

  function clearFilters() {
    setQInput("");
    setGameInput("");
    setDebouncedGameInput("");
    setGamePickerOpen(false);
    pushSearch({});
  }

  const feedParams: PostFeedParams = { feed: "global" };
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

      <div className="relative">
        <Search className="text-muted-foreground absolute top-2.5 left-2.5 h-4 w-4" />
        <Input
          type="search"
          aria-label={m.discover_search_aria()}
          placeholder={m.discover_search_placeholder()}
          className="pl-9"
          value={qInput}
          onChange={(event) => onQChange(event.target.value)}
        />
      </div>

      <div className="relative">
        {trimmedGame ? (
          <ActiveGameChip slug={trimmedGame} onRemove={() => pushSearch({ q: trimmedQ })} />
        ) : (
          <>
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 h-4 w-4" />
            <Input
              type="search"
              aria-label={m.discover_game_filter_aria()}
              placeholder={m.discover_game_filter_placeholder()}
              className="pl-9"
              value={gameInput}
              onChange={(event) => onGameInputChange(event.target.value)}
              onFocus={() => {
                if (gameInput.trim()) setGamePickerOpen(true);
              }}
              onBlur={() => {
                // Let a picker click land before the blur closes it.
                setTimeout(() => setGamePickerOpen(false), 120);
              }}
            />
            {gamePickerOpen && debouncedGameInput && (
              <GamePickerList query={debouncedGameInput} onSelect={selectGame} />
            )}
          </>
        )}
      </div>

      <PostFeed
        feedAtom={postFeedAtom(feedParams)}
        emptyMessage={isFiltered ? m.discover_filtered_empty() : m.discover_empty()}
        emptyIcon={Compass}
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

  if (listing.isPending || games.length === 0) return null;

  return (
    <ul
      aria-label={m.discover_game_filter_aria()}
      className="border-border bg-card absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg border shadow-lg"
    >
      {games.map((game) => (
        <li key={game.igdbId}>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(game.slug)}
            className="hover:bg-muted flex w-full items-center gap-3 px-3 py-2 text-left"
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
