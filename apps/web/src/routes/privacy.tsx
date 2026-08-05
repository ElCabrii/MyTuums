import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPolicy } from "@/components/legal/privacy-policy";

/** The privacy policy route — renders `PrivacyPolicy` in the current locale. */
export const Route = createFileRoute("/privacy")({
  component: PrivacyPolicy,
});
