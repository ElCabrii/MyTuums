import { createFileRoute } from "@tanstack/react-router";
import { BannedPage } from "@/components/banned-page";

/** The banned-account screen (issue #74) — renders `BannedPage` with no search params of its own. */
export const Route = createFileRoute("/banned")({
  component: BannedPage,
});
