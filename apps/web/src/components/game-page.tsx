import { useAtomValue } from "jotai";
import { Calendar, Gamepad2, Loader2 } from "lucide-react";
import { GameCover } from "@/components/game-cover";
import { gamePageAtomFamily } from "@/atoms/games";
import { useDocumentHead } from "@/hooks/use-document-head";
import type { GamePageData } from "@/lib/orpc";
import { m } from "@/paraglide/messages.js";

/**
 * One game's public page (`/games/$slug`, issue #314, Q22): strictly game
 * data — cover, name, summary, release year, genres, platforms, favorites
 * count. No post feed (Q14/Q19: that was explored and deliberately
 * rejected), no reviews yet.
 *
 * The favorite button arrives in stage 3; the count renders now because it
 * is public data (Q26's showcase). The page is public for anonymous readers
 * too (Q6): nothing here needs a session.
 */
export function GamePage({ slug }: { slug: string }) {
  const game = useAtomValue(gamePageAtomFamily(slug));

  if (game.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="text-primary dark:text-link h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
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

  return <GameDetail game={game.data} />;
}

function GameDetail({ game }: { game: GamePageData }) {
  // The tab title follows the data (the crawler head mirrors this text
  // server-side — see publicGameHead's bounds).
  useDocumentHead(game.name);

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
