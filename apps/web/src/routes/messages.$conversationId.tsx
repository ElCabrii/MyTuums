import { createFileRoute } from "@tanstack/react-router";
import { MessageThreadPane } from "@/components/message-thread";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/**
 * The thread as a sub-route: the mobile stack replaces the list with it, the
 * desktop two-pane renders it in the right half. A hidden side or a block
 * reads as a missing conversation server-side; the pane renders its error
 * state rather than guessing.
 */
export const Route = createFileRoute("/messages/$conversationId")({
  head: () => pageHead(m.messages_title(), m.messages_document_description(), "/messages"),
  component: ThreadRoute,
});

function ThreadRoute() {
  const { conversationId } = Route.useParams();
  // Keyed by conversation: the router keeps this component mounted across a
  // param change, and without the key the composer's draft (local state)
  // would survive the switch — typed for one person, sent to another.
  return <MessageThreadPane key={conversationId} conversationId={conversationId} />;
}
