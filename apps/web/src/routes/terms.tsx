import { createFileRoute } from "@tanstack/react-router";
import { TermsOfService } from "@/components/legal/terms-of-service";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/** The terms of service route — renders `TermsOfService` in the current locale. */
export const Route = createFileRoute("/terms")({
  head: () => pageHead(m.legal_terms_of_service(), m.terms_document_description(), "/terms"),
  component: TermsOfService,
});
