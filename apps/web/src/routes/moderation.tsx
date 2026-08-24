import { createFileRoute } from "@tanstack/react-router";
import { ModerationPage } from "@/components/moderation/moderation-page";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/moderation")({
  head: () => pageHead(m.moderation_title()),
  component: ModerationPage,
});
