import { createFileRoute } from "@tanstack/react-router";
import { TermsOfService } from "@/components/legal/terms-of-service";

/** The terms of service route — renders `TermsOfService` in the current locale. */
export const Route = createFileRoute("/terms")({
  component: TermsOfService,
});
