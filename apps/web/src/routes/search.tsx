import { createFileRoute } from "@tanstack/react-router";
import { SearchPage } from "@/components/search-page";

export const Route = createFileRoute("/search")({
  component: SearchPage,
  /**
   * `q` arrives from *outside* — the header's search box navigates here with
   * whatever was typed into it — so it is narrowed to a string rather than
   * trusted: anything that isn't a string is dropped, and the page renders
   * its "type something" prompt instead of a raw value.
   */
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    ...(typeof search.q === "string" ? { q: search.q } : {}),
  }),
});
