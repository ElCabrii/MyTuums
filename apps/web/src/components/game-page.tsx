import { useAtomValue, useSetAtom } from "jotai";
import { Link } from "@tanstack/react-router";
import { Calendar, Gamepad2, Star } from "lucide-react";
import { GameCover } from "@/components/game-cover";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { gamePageAtomFamily, toggleFavoriteAtomFamily } from "@/atoms/games";
import { viewerAtom } from "@/atoms/session";
import { useDocumentHead } from "@/hooks/use-document-head";
import type { GamePageData } from "@/lib/orpc";
import { sanitizeDestination } from "@/lib/redirect";
import { m } from "@/paraglide/messages.js";

/**
 * One game's public page (`/games/$slug`, issue #314, Q22): strictly game
 * data — cover, name, summary, release year, genres, platforms, favorites
 * count and the favorite button. No post feed (Q14/Q19: that was explored
 * and deliberately rejected), no reviews yet.
 *
 * The page is public for anonymous readers too (Q6): the favorite button is
 * the one affordance that needs a session, so it degrades to the sign-in
 * link the public permalink's action bar established.
 */
export function GamePage({ slug }: { slug: string }) {
  const game = useAtomValue(gamePageAtomFamily(slug));

  if (game.isPending) {
    return <GameDetailSkeleton />;
  }

  if (game.isError || !game.data) {
    // NOT_FOUND and a failed load render the same quiet state: the catalog
    // never delists (Q29), so a missing slug is a typo, and an error message
    // with a retry needs a mutation-free page to have something to retry
    // into — the reader can navigate back to the directory instead.
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="border-border bg-card/40 rounded-xl border border-dashed p-10 text-center">
          <Gamepad2 className="text-muted-foreground/60 mx-auto mb-3 h-8 w-8" />
          <p className="text-muted-foreground text-sm">{m.game_not_found()}</p>
        </div>
      </div>
    );
  }

  return <GameDetail game={game.data} slug={slug} />;
}

/**
 * The `GamePage` loading state: hero cover, title, year, favorite button and
 * description rows, in the detail's own layout so nothing jumps when it lands.
 *
 * `aria-hidden`: it paints structure, not information.
 */
export function GameDetailSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8" aria-hidden>
      <div className="gap-6 sm:flex">
        <Skeleton className="mx-auto aspect-[2/3] w-40 shrink-0 rounded-lg motion-reduce:animate-none sm:mx-0 sm:w-48" />
        <div className="mt-4 min-w-0 flex-1 sm:mt-0">
          <Skeleton className="h-7 w-48 motion-reduce:animate-none" />
          <Skeleton className="mt-2 h-4 w-32 motion-reduce:animate-none" />
          <Skeleton className="mt-2 h-4 w-24 motion-reduce:animate-none" />
          <Skeleton className="mt-3 h-9 w-32 rounded-full motion-reduce:animate-none" />
        </div>
      </div>
      <Skeleton className="mt-6 h-4 w-full motion-reduce:animate-none" />
      <Skeleton className="mt-2 h-4 w-5/6 motion-reduce:animate-none" />
      <Skeleton className="mt-2 h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  );
}

function GameDetail({ game, slug }: { game: GamePageData; slug: string }) {
  const viewer = useAtomValue(viewerAtom);
  const toggleFavorite = useSetAtom(toggleFavoriteAtomFamily(slug));
  // The tab title follows the data (the crawler head mirrors this text
  // server-side — see publicGameHead's bounds).
  useDocumentHead(game.name);
  const href = `/games/${slug}`;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="gap-6 sm:flex">
        <div className="bg-muted mx-auto w-40 shrink-0 overflow-hidden rounded-lg sm:mx-0 sm:w-48">
          <div className="aspect-[2/3]">
            <GameCover cover={game.coverMediaPath} name={game.name} sizes="192px" />
          </div>
        </div>

        <div className="mt-4 min-w-0 flex-1 sm:mt-0">
          <h1 className="text-foreground text-2xl font-bold tracking-tight">{game.name}</h1>
          {game.firstReleaseYear !== null && (
            <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-sm">
              <Calendar className="h-4 w-4" aria-hidden />
              {m.game_released_in({ year: game.firstReleaseYear })}
            </p>
          )}
          <p className="text-muted-foreground mt-2 text-sm">
            {m.game_favorite_count({ count: game.favoriteCount })}
          </p>

          <div className="mt-3">
            {viewer ? (
              <Button
                variant={game.viewerHasFavoritedGame ? "secondary" : "default"}
                aria-pressed={game.viewerHasFavoritedGame}
                onClick={() => toggleFavorite()}
                className="mt-1"
              >
                <Star
                  className="h-4 w-4"
                  aria-hidden
                  // The filled star is the state, not decoration — a solid
                  // glyph reads at a glance where a variant swap does not.
                  fill={game.viewerHasFavoritedGame ? "currentColor" : "none"}
                />
                {game.viewerHasFavoritedGame
                  ? m.game_unfavorite_action()
                  : m.game_favorite_action()}
              </Button>
            ) : (
              // The anonymous reader's one affordance: the count above is
              // public, the button is not — sign in, then favorite.
              <Link
                to="/login"
                search={{ redirect: sanitizeDestination(href) ?? undefined }}
                className="text-link mt-1 inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-2"
              >
                <Star className="h-4 w-4" aria-hidden />
                {m.game_favorite_signed_out()}
              </Link>
            )}
          </div>
        </div>
      </div>

      {game.summary !== null && (
        <p className="text-foreground mt-6 leading-relaxed whitespace-pre-line">{game.summary}</p>
      )}

      {game.genres.length > 0 && <LabelGroup heading={m.game_genres()} labels={game.genres} />}
      {game.platforms.length > 0 && (
        <LabelGroup heading={m.game_platforms()} labels={game.platforms} />
      )}
    </div>
  );
}

/** A titled row of catalog labels (genres, platforms) — chips in name order. */
function LabelGroup({ heading, labels }: { heading: string; labels: string[] }) {
  return (
    <section className="mt-6">
      <h2 className="text-foreground text-sm font-bold">{heading}</h2>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {labels.map((label) => (
          <li
            key={label}
            className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-xs"
          >
            {label}
          </li>
        ))}
      </ul>
    </section>
  );
}
