import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPolicy } from "@/components/legal/privacy-policy";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/** The privacy policy route — renders `PrivacyPolicy` in the current locale. */
export const Route = createFileRoute("/privacy")({
  head: () => pageHead(m.legal_privacy_policy()),
  component: PrivacyPolicy,
});
