import { createFileRoute } from "@tanstack/react-router";
import { GamePage } from "@/components/game-page";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";

/**
 * One game's public page (`/games/$slug`, issue #314, Q21): a data-populated
 * public route exactly like `/@{username}` — the SPA shell boots, the page
 * atom reads `game.bySlug`, and the crawler head comes from the server
 * (`public-heads.ts`). Public for anonymous readers (Q6).
 */
export const Route = createFileRoute("/games/$slug")({
  // The data-dependent title lands via `useDocumentHead` once the page atom
  // resolves; this is the pre-JS crawl shell's copy, mirrored in English by
  // `ROUTE_HEADS`-adjacent `publicGameHead`.
  head: () => pageHead(m.games_title(), m.game_document_description(), "/games"),
  component: GameRoute,
});

function GameRoute() {
  const { slug } = Route.useParams();
  return <GamePage slug={slug} />;
}
