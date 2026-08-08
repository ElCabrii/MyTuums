import { createFileRoute } from "@tanstack/react-router";
import { MentionsLegales } from "@/components/legal/mentions-legales";

/** The LCEN legal-notice route — renders `MentionsLegales` in the current locale. */
export const Route = createFileRoute("/mentions-legales")({
  component: MentionsLegales,
});
