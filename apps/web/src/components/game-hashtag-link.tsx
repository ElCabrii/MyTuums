import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ORPCError } from "@orpc/client";
import { gamePageAtomFamily } from "@/atoms/games";
import { GameCover } from "@/components/game-cover";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages.js";

const GAME_HOVER_DELAY = 600;
const GAME_HOVER_CLOSE_DELAY = 300;

/**
 * A game hashtag (`#doom`) with the shared game preview attached to it.
 *
 * Hover shows the game card — cover, name, year, favorites count and a link
 * to the game's page. Click goes to Discover filtered on the game
 * (`/discover?game=slug`), where the conversation about it lives; the game
 * page itself stays one click away inside the card. Unresolved tags never
 * reach this component — they keep their post-search link in `linked-text`.
 *
 * The trigger composes onto TanStack Router's actual `<a>` (the ProfileLink
 * pattern) so middle-click, open-in-new-tab and the router's own handling
 * survive while Base UI adds hover/focus and Escape dismissal.
 */
export function GameHashtagLink({ label, slug }: { label: string; slug: string }) {
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={GAME_HOVER_DELAY}
        closeDelay={GAME_HOVER_CLOSE_DELAY}
        render={
          <Link
            to="/discover"
            search={{ game: slug }}
            className="text-link hover:text-link/80 underline underline-offset-2"
          >
            {label}
          </Link>
        }
      />
      <HoverCardContent>
        <GameHoverCardContent slug={slug} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** The game data view rendered inside a trigger's portal. */
function GameHoverCardContent({ slug }: { slug: string }) {
  const gameQuery = useAtomValue(gamePageAtomFamily(slug));

  if (gameQuery.isPending) {
    return (
      <div className="space-y-3" aria-label={m.game_hover_loading()}>
        <div className="flex items-center gap-3">
          <Skeleton className="h-14 w-10 rounded-md" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
        <Skeleton className="h-8 w-24" />
      </div>
    );
  }

  if (gameQuery.isError || !gameQuery.data) {
    const isNotFound = gameQuery.error instanceof ORPCError && gameQuery.error.code === "NOT_FOUND";

    return (
      <p className="text-muted-foreground text-sm" role="status">
        {isNotFound ? m.game_not_found() : m.game_hover_error()}
      </p>
    );
  }

  const game = gameQuery.data;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Link
          to="/games/$slug"
          params={{ slug }}
          aria-label={m.game_hover_view()}
          className="focus-visible:ring-ring shrink-0 overflow-hidden rounded-md outline-none focus-visible:ring-2"
        >
          <span className="bg-muted block h-14 w-10 overflow-hidden">
            <GameCover cover={game.coverMediaPath} name={game.name} sizes="40px" />
          </span>
        </Link>
        <div className="min-w-0">
          <Link
            to="/games/$slug"
            params={{ slug }}
            className="text-foreground block truncate font-bold hover:underline"
          >
            {game.name}
          </Link>
          {game.firstReleaseYear !== null && (
            <p className="text-muted-foreground text-xs">{game.firstReleaseYear}</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          {m.game_favorite_count({ count: game.favoriteCount })}
        </span>
        <Link
          to="/games/$slug"
          params={{ slug }}
          className="text-link hover:text-link/80 text-xs font-medium underline underline-offset-2"
        >
          {m.game_hover_view()}
        </Link>
      </div>
    </div>
  );
}
