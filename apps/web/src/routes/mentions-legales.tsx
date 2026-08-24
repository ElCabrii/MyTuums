import { createFileRoute } from "@tanstack/react-router";
import { MentionsLegales } from "@/components/legal/mentions-legales";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/** The LCEN legal-notice route — renders `MentionsLegales` in the current locale. */
export const Route = createFileRoute("/mentions-legales")({
  head: () => pageHead(m.legal_notice()),
  component: MentionsLegales,
});
