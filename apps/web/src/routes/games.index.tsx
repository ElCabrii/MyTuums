import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { GamesPage } from "@/components/games-page";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";

/** The public game directory's hub (`/games`, issue #314, Q18). */
export const Route = createFileRoute("/games/")({
  head: () => pageHead(m.games_title(), m.games_document_description(), "/games"),
  component: GamesPage,
  /** Keep the selected sort in the URL so a directory view is shareable. */
  validateSearch: (search) => gamesSearchSchema.parse(search),
});

const gamesSearchSchema = z.object({
  // `.catch()` degrades a hand-edited or stale `?sort=` to the default view
  // instead of erroring the route — the same stance as the profile filter.
  sort: z
    .enum(["popularity", "name", "year", "favorites", "upcoming"])
    .optional()
    .catch("popularity"),
});
