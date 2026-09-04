import { createFileRoute } from "@tanstack/react-router";
import { DiscoverPage } from "@/components/discover-page";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";

/** The Discover route — a valid target for the header/footer "Discover" links and the empty-following-feed CTA. */
export const Route = createFileRoute("/discover")({
  head: () => pageHead(m.nav_discover(), m.discover_document_description(), "/discover"),
  component: DiscoverPage,
});
