import { createFileRoute } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { m } from "@/paraglide/messages.js";

/** The Discover route — a valid target for the header/footer "Discover" links and the empty-following-feed CTA. */
export const Route = createFileRoute("/discover")({
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
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
        <Compass className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{m.discover_coming_soon()}</p>
      </div>
    </div>
  );
}
