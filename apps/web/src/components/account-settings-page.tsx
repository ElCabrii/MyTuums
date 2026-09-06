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
import { PrivacySection } from "@/components/settings/privacy-section";
import { AnalyticsSection } from "@/components/settings/analytics-section";
import { FollowRequestsSection } from "@/components/settings/follow-requests-section";
import { TwoFactorSection } from "@/components/settings/two-factor-section";
import { PasskeySection } from "@/components/settings/passkey-section";
import { LinkedAccountsSection } from "@/components/settings/linked-accounts-section";
import { BlockedUsersSection } from "@/components/settings/blocked-users-section";
import { SignOutSection } from "@/components/settings/sign-out-section";
import { m } from "@/paraglide/messages.js";

/**
 * A single `settings.account.tsx` with no `settings.tsx` layout beside it.
 *
 * TanStack's file routing would make a `settings.tsx` a *layout* rendering an
 * `<Outlet/>`, and without a `settings.index.tsx` sibling `/settings` would
 * then render a chrome with an empty body rather than 404 — the same trap
 * `@{$username}.tsx` documents in CONTEXT.md. One file, one URL, no empty state
 * to explain.
 *
 * The sections themselves live in `components/settings/`. This file owns the
 * two things that are genuinely the page's rather than any section's: the
 * single error banner every section writes to through `authErrorAtom`, and
 * the grouping and order the sections appear in — two groups, Profile (the
 * picture, banner, name, bio and handle other people see) and Account
 * (password, preferences, two-factor, passkeys, linked accounts, blocked
 * users, and sign-out last). Sign-out closes the page as a section (issue
 * #282 partially reverts #217): the navbar account menu (`header.tsx`)
 * remains the always-visible affordance, and the profile page no longer
 * carries its own button. (The signed-in gate lives at the root —
 * `__root.tsx` renders nothing until the session settles — so the page
 * needs no guard of its own.)
 */
export function AccountSettingsPage() {
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
    <div className="container mx-auto max-w-2xl space-y-6 px-4 py-12">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{m.settings_title()}</h1>
        <p className="text-muted-foreground text-sm">{m.settings_subtitle()}</p>
      </div>

      {/* One banner for the whole page. Every section's action atom writes the
          same `authErrorAtom`, so a failure anywhere surfaces here rather than
          each section growing its own alert region — which would also mean
          several `role="alert"`s competing for announcement. */}
      {error && <ErrorBanner message={localizeAuthError(error)} />}

      {/* Two groups: what other people see, then everything that governs the
          account itself. The group `<h2>`s are the page's section landmarks;
          each card's own title is an `<h3>` (see `components/settings/section.tsx`)
          so the heading hierarchy reads page → group → card. Sign-out closes
          the Account group — the deliberate end-of-review exit (issue #282);
          the navbar account menu (`header.tsx`) is the always-visible one. */}
      <section className="space-y-4">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          {m.settings_group_profile()}
        </h2>
        <ProfileSection />
        <HandleSection />
      </section>

      <section className="space-y-4">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          {m.settings_group_account()}
        </h2>
        <PasswordSection />
        <PreferencesSection />
        <PrivacySection />
        <AnalyticsSection />
        <FollowRequestsSection />
        <TwoFactorSection />
        <PasskeySection />
        <LinkedAccountsSection />
        <BlockedUsersSection />
        <SignOutSection />
      </section>
    </div>
  );
}
