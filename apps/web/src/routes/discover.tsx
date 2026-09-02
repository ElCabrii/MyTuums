import { createFileRoute } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";

/** The Discover route — a valid target for the header/footer "Discover" links and the empty-following-feed CTA. */
export const Route = createFileRoute("/discover")({
  head: () => pageHead(m.nav_discover(), m.discover_document_description(), "/discover"),
  component: DiscoverPage,
});

/**
 * The Discover page — a deliberate stub. No UI exists for this page yet, but
 * the route is a live nav item (header, footer, the empty-following-feed CTA),
 * so it renders the same dashed empty state the feeds use instead of a blank
 * page (issue #59).
 */
function DiscoverPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
      {/* A real h1 — the route is a live nav target, and every page state
          needs a heading for the document outline (Lighthouse's heading
          audit flagged the bare stub). */}
      <h1 className="text-lg font-bold tracking-tight">{m.nav_discover()}</h1>
      <div className="border-border bg-card/40 rounded-xl border border-dashed p-10 text-center">
        <Compass className="text-muted-foreground/60 mx-auto mb-3 h-8 w-8" />
        <p className="text-muted-foreground text-sm">{m.discover_coming_soon()}</p>
      </div>
    </div>
  );
}
