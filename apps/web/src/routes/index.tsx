import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/components/home-page";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/** The home feed route (`/`) — renders `HomePage`. */
export const Route = createFileRoute("/")({
  head: () => pageHead(m.feed_title()),
  component: HomePage,
});
