import { createFileRoute } from "@tanstack/react-router";
import { MessageRequestsPage } from "@/components/message-requests-page";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/messages/requests")({
  head: () =>
    pageHead(m.messages_requests_title(), m.messages_document_description(), "/messages/requests"),
  component: MessageRequestsPage,
});
