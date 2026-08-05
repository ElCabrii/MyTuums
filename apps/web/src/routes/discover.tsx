import { createFileRoute } from "@tanstack/react-router";

/** The Discover route — a valid target for the header/footer "Discover" links and the empty-following-feed CTA, but nothing renders yet. */
export const Route = createFileRoute("/discover")({
  component: DiscoverPage,
});

/**
 * The Discover page — a deliberate stub. No UI exists for this page yet, and a
 * route that renders nothing is better than a link that 404s, so it returns
 * null until the feature lands.
 */
function DiscoverPage() {
  return null;
}
