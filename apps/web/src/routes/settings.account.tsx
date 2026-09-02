import { createFileRoute } from "@tanstack/react-router";
import { AccountSettingsPage } from "@/components/account-settings-page";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";

export const Route = createFileRoute("/settings/account")({
  head: () => pageHead(m.settings_title(), m.settings_document_description(), "/settings/account"),
  component: AccountSettingsPage,
});
