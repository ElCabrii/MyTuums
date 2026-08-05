import { createFileRoute } from "@tanstack/react-router";
import { MentionsLegales } from "@/components/legal/mentions-legales";

/** The French LCEN legal-notice route — renders `MentionsLegales` (deliberately French-only, see its doc). */
export const Route = createFileRoute("/mentions-legales")({
  component: MentionsLegales,
});
