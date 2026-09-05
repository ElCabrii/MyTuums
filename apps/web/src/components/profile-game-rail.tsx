import { useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { GameCover } from "@/components/game-cover";
import { gameFavoritesAtomFamily } from "@/atoms/games";
import { m } from "@/paraglide/messages.js";

/**
 * One profile's favorites rail (issue #314, Q11/Q25): the games a user has
 * favorited, newest first — a horizontal scroll-snap cover strip on mobile,
 * a parallel column beside the feed on desktop (the parent places both).
 *
 * A showcase, not a feed (Q26): visible to every signed-in profile viewer,
 * by design — except on a private profile, where the server redacts it to
 * empty for non-followers like the follow graphs, so nothing renders here.
 * Renders nothing when the profile has no favorites — an empty rail is a
 * hole in the page, not information. Pending and error states
 * render nothing too: the rail is decoration around a profile that must
 * render whatever the favorites query does.
 */
export function ProfileGameRail({ username }: { username: string }) {
  const favorites = useAtomValue(gameFavoritesAtomFamily(username));
  const games = favorites.data?.items ?? [];

  if (games.length === 0) return null;

  return (
    <section aria-label={m.profile_favorite_games()} className="space-y-2">
      <h2 className="text-foreground text-sm font-bold">{m.profile_favorite_games()}</h2>
      <ol
        className="snap-x snap-mandatory list-none overflow-x-auto p-0 lg:grid lg:grid-cols-3 lg:gap-2 lg:overflow-visible"
        style={{ scrollbarWidth: "thin" }}
      >
        {games.map((game) => (
          <li key={game.slug} className="snap-start">
            <Link
              to="/games/$slug"
              params={{ slug: game.slug }}
              aria-label={game.name}
              className="focus-visible:ring-ring block overflow-hidden rounded-md focus-visible:ring-2 focus-visible:outline-none"
            >
              <div className="bg-muted aspect-[2/3] overflow-hidden rounded-md">
                <GameCover
                  cover={game.coverMediaPath}
                  name={game.name}
                  sizes="(min-width: 1024px) 90px, 96px"
                />
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
