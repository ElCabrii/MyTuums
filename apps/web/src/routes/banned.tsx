import { createFileRoute } from "@tanstack/react-router";
import { BannedPage } from "@/components/banned-page";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/** The banned-account screen (issue #74) — renders `BannedPage` with no search params of its own. */
export const Route = createFileRoute("/banned")({
  head: () => pageHead(m.banned_title(), m.banned_document_description(), "/banned"),
  component: BannedPage,
});
