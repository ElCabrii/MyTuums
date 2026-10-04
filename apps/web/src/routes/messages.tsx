import { createFileRoute } from "@tanstack/react-router";
import { MessagesPage } from "@/components/messages-page";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/**
 * Not in `SIGNED_OUT_PATHS`: private messages are the viewer's own mail, so
 * the server's page gate redirects a signed-out fetcher to `/login`.
 */
export const Route = createFileRoute("/messages")({
  head: () => pageHead(m.messages_title(), m.messages_document_description(), "/messages"),
  component: MessagesPage,
});
