import { createFileRoute } from "@tanstack/react-router";
import { NewMessagePane } from "@/components/message-thread";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/**
 * The profile "Message" action's landing: resolves an existing visible
 * conversation (and moves to it), else offers the composer — the
 * conversation is created idempotently by the first send itself.
 */
export const Route = createFileRoute("/messages/new/$userId")({
  head: () => pageHead(m.messages_new_title(), m.messages_document_description(), "/messages"),
  component: NewRoute,
});

function NewRoute() {
  const { userId } = Route.useParams();
  return <NewMessagePane userId={userId} />;
}
