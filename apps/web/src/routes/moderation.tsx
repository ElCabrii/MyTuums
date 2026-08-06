import { createFileRoute } from "@tanstack/react-router";
import { ModerationPage } from "@/components/moderation/moderation-page";

export const Route = createFileRoute("/moderation")({
  component: ModerationPage,
});
