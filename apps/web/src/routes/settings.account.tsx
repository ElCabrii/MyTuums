import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { authErrorAtom } from "@/atoms/auth";
import { viewerAtom } from "@/atoms/session";
import { openTwoFactorPanelAtom } from "@/atoms/two-factor";
import { resetPasskeyFormsAtom } from "@/atoms/passkey";
import { localizeAuthError } from "@/lib/auth-error-message";
import { ErrorBanner } from "@/components/error-banner";
import { ProfileSection } from "@/components/settings/profile-section";
import { HandleSection } from "@/components/settings/handle-section";
import { PasswordSection } from "@/components/settings/password-section";
import { PreferencesSection } from "@/components/settings/preferences-section";
import { TwoFactorSection } from "@/components/settings/two-factor-section";
import { PasskeySection } from "@/components/settings/passkey-section";
import { LinkedAccountsSection } from "@/components/settings/linked-accounts-section";
import { BlockedUsersSection } from "@/components/settings/blocked-users-section";
import { SignOutSection } from "@/components/settings/sign-out-section";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/settings/account")({
  component: AccountSettingsPage,
});

/**
 * A flat `settings.account.tsx` with no `settings.tsx` layout beside it.
 *
 * TanStack's file routing would make a `settings.tsx` a *layout* rendering an
 * `<Outlet/>`, and without a `settings.index.tsx` sibling `/settings` would
 * then render a chrome with an empty body rather than 404 — the same trap
 * `@{$username}.tsx` documents in CLAUDE.md. One file, one URL, no empty state
 * to explain.
 *
 * The sections themselves live in `components/settings/`. This file owns the
 * two things that are genuinely the page's rather than any section's: the
 * single error banner every section writes to through `authErrorAtom`, and
 * the order the sections appear in — profile first (what other people see),
 * then identity and credentials, then preferences, then the security
 * enrolments, then the privacy list (blocked users), and sign-out last. (The
 * signed-in gate lives at the root — `__root.tsx` renders nothing until the
 * session settles — so the page needs no guard of its own.)
 */
function AccountSettingsPage() {
  const viewer = useAtomValue(viewerAtom);
  const error = useAtomValue(authErrorAtom);

  const resetPasskeyForms = useSetAtom(resetPasskeyFormsAtom);
  const closePanel = useSetAtom(openTwoFactorPanelAtom);
  useEffect(() => {
    return () => {
      resetPasskeyForms();
      closePanel("idle");
    };
  }, [resetPasskeyForms, closePanel]);

  if (!viewer) return null;

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{m.settings_title()}</h1>
        <p className="text-sm text-muted-foreground">{m.settings_subtitle()}</p>
      </div>

      {/* One banner for the whole page. Every section's action atom writes the
          same `authErrorAtom`, so a failure anywhere surfaces here rather than
          each section growing its own alert region — which would also mean
          several `role="alert"`s competing for announcement. */}
      {error && <ErrorBanner message={localizeAuthError(error)} />}

      <ProfileSection />
      <HandleSection />
      <PasswordSection />
      <PreferencesSection />
      <TwoFactorSection />
      <PasskeySection />
      <LinkedAccountsSection />
      <BlockedUsersSection />
      <SignOutSection />
    </div>
  );
}
