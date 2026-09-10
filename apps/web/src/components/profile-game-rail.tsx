import { useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { Gamepad2 } from "lucide-react";
import { GameCover } from "@/components/game-cover";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { gameFavoritesAtomFamily } from "@/atoms/games";
import type { FavoriteRailItem } from "@/lib/orpc";
import { m } from "@/paraglide/messages.js";

const PREVIEW_COUNT = 6;

/** A six-cover showcase; the popover can page through every visible favorite. */
export function ProfileGameRail({
  username,
  isOwnProfile = false,
}: {
  username: string;
  isOwnProfile?: boolean;
}) {
  const favorites = useAtomValue(gameFavoritesAtomFamily(username));
  const games = favorites.data?.pages.flatMap((page) => page.items) ?? [];
  if (!favorites.data) return null;
  return (
    <section aria-label={m.profile_favorite_games()} className="space-y-3">
      <h2 className="text-foreground text-sm font-bold">{m.profile_favorite_games()}</h2>
      {games.length === 0 ? (
        <div className="border-border bg-muted/20 space-y-3 rounded-2xl border border-dashed p-4 text-sm">
          <Gamepad2 className="text-muted-foreground size-6" />
          <p className="text-muted-foreground">
            {isOwnProfile ? m.profile_favorites_empty_own() : m.profile_favorites_empty_other()}
          </p>
          <Link
            to="/games"
            className="text-link focus-visible:ring-ring inline-flex min-h-11 items-center font-medium underline underline-offset-4 outline-none focus-visible:ring-2"
          >
            {m.profile_favorites_browse()}
          </Link>
        </div>
      ) : (
        <ol className="flex gap-2 overflow-x-auto overscroll-x-contain pb-2 lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0">
          {games.slice(0, PREVIEW_COUNT).map((game) => (
            <li key={game.slug} className="w-16 shrink-0 sm:w-20 lg:w-auto">
              <FavoriteGameLink game={game} />
            </li>
          ))}
        </ol>
      )}
      {games.length > PREVIEW_COUNT && (
        <Popover>
          <PopoverTrigger render={<Button variant="outline" size="sm" />}>
            {m.profile_favorites_see_more()}
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="max-h-[min(32rem,var(--available-height))] w-80 max-w-[min(calc(100vw-2rem),var(--available-width))] overflow-y-auto overscroll-contain"
          >
            <PopoverTitle>{m.profile_favorite_games()}</PopoverTitle>
            <ol className="grid grid-cols-3 gap-3">
              {games.map((game) => (
                <li key={game.slug} className="min-w-0">
                  <FavoriteGameLink game={game} showName />
                </li>
              ))}
            </ol>
            {favorites.isFetchNextPageError && (
              <p role="alert" className="text-destructive text-sm">
                {m.profile_favorites_error()}
              </p>
            )}
            {favorites.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 self-start"
                disabled={favorites.isFetchingNextPage}
                onClick={() => void favorites.fetchNextPage()}
              >
                {m.profile_favorites_load_more()}
              </Button>
            )}
          </PopoverContent>
        </Popover>
      )}
    </section>
  );
}

function FavoriteGameLink({
  game,
  showName = false,
}: {
  game: FavoriteRailItem;
  showName?: boolean;
}) {
  return (
    <Link
      to="/games/$slug"
      params={{ slug: game.slug }}
      aria-label={game.name}
      title={game.name}
      className="focus-visible:ring-ring block min-w-0 space-y-1 rounded-md outline-none focus-visible:ring-2"
    >
      <div className="bg-muted aspect-[2/3] overflow-hidden rounded-md">
        <GameCover
          cover={game.coverMediaPath}
          name={game.name}
          sizes="(min-width: 1024px) 100px, 30vw"
        />
      </div>
      {showName && <span className="block text-xs [overflow-wrap:anywhere]">{game.name}</span>}
    </Link>
  );
}
