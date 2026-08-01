import { createFileRoute } from "@tanstack/react-router";
import { TermsOfService } from "@/components/legal/terms-of-service";

export const Route = createFileRoute("/terms")({
  component: TermsOfService,
});
