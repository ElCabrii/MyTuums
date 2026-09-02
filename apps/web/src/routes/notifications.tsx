import { createFileRoute } from "@tanstack/react-router";
import { NotificationsPage } from "@/components/notifications-page";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/**
 * Not in `SIGNED_OUT_PATHS`, so the server's page gate redirects a signed-out
 * fetcher to `/login` — notifications are the viewer's own mail, not public
 * content.
 */
export const Route = createFileRoute("/notifications")({
  head: () =>
    pageHead(m.notifications_title(), m.notifications_document_description(), "/notifications"),
  component: NotificationsPage,
});
