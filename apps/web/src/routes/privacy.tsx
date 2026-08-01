import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPolicy } from "@/components/legal/privacy-policy";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPolicy,
});
