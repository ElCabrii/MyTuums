import { createFileRoute } from "@tanstack/react-router";
import { MentionsLegales } from "@/components/legal/mentions-legales";

export const Route = createFileRoute("/mentions-legales")({
  component: MentionsLegales,
});
