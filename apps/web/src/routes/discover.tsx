import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { DiscoverPage } from "@/components/discover-page";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";

/** The Discover route — a valid target for the header/footer "Discover" links and the empty-following-feed CTA. */
export const Route = createFileRoute("/discover")({
  head: () => pageHead(m.nav_discover(), m.discover_document_description(), "/discover"),
  component: DiscoverPage,
  /**
   * Discover filters live in the URL so a filtered view is shareable and the
   * back button restores it — the same stance as the `/games` sort. Both are
   * free-text from outside (a hashtag click navigates with `?game=slug`), so
   * anything that is not a string is dropped and the page renders unfiltered
   * instead of erroring the route.
   */
  validateSearch: (search) => discoverSearchSchema.parse(search),
});

const discoverSearchSchema = z.object({
  q: z.string().trim().optional(),
  game: z.string().trim().optional(),
});
