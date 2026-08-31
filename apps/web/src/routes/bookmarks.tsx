import { createFileRoute } from "@tanstack/react-router";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";
import { BookmarksPage } from "@/components/bookmarks-page";

/**
 * The bookmarks route — the viewer's private saved posts. Gated like every
 * main content route: the path is absent from `SIGNED_OUT_PATHS`, so the
 * server's page gate redirects a signed-out fetcher to `/login` before the
 * SPA ever renders here.
 */
export const Route = createFileRoute("/bookmarks")({
  head: () => pageHead(m.bookmarks_title(), m.bookmarks_document_description(), "/bookmarks"),
  component: BookmarksPage,
});
