import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle } from "lucide-react";
import { authErrorAtom } from "@/atoms/auth";
import { isSignedInAtom, sessionPendingAtom, viewerAtom } from "@/atoms/session";
import { openTwoFactorPanelAtom } from "@/atoms/two-factor";
import { resetPasskeyFormsAtom } from "@/atoms/passkey";
import { localizeAuthError } from "@/lib/auth-error-message";
import { ProfileSection } from "@/components/settings/profile-section";
import { HandleSection } from "@/components/settings/handle-section";
import { PasswordSection } from "@/components/settings/password-section";
import { PreferencesSection } from "@/components/settings/preferences-section";
import { TwoFactorSection } from "@/components/settings/two-factor-section";
import { PasskeySection } from "@/components/settings/passkey-section";
import { LinkedAccountsSection } from "@/components/settings/linked-accounts-section";
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
 * three things that are genuinely the page's rather than any section's: the
 * signed-in guard, the single error banner every section writes to through
 * `authErrorAtom`, and the order the sections appear in — profile first
 * (what other people see), then identity and credentials, then preferences,
 * then the security enrolments, and sign-out last.
 */
function AccountSettingsPage() {
  const navigate = useNavigate();
  const isSignedIn = useAtomValue(isSignedInAtom);
  const isSessionPending = useAtomValue(sessionPendingAtom);
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

  /**
   * Signed-out visitors have nothing to configure.
   *
   * **The `isSessionPending` guard is not optional.** `isSignedInAtom` is
   * derived from `session.data`, which is null while BetterAuth's first
   * `/get-session` is still in flight — so on a cold load of this URL a
   * perfectly valid session reads as signed *out* for the first tick. Without
   * the guard this effect fires immediately, lands on `/login`, and
   * `useRedirectWhenSignedIn` there then bounces to the profile: the settings
   * page becomes unreachable by direct link or refresh, while working fine
   * when navigated to from inside the app. Found by loading the URL directly;
   * no test caught it, because tests arrive here already warm.
   */
  useEffect(() => {
    if (isSessionPending) return;
    if (!isSignedIn) void navigate({ to: "/login", replace: true });
  }, [isSessionPending, isSignedIn, navigate]);

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
      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl bg-destructive/10 border border-destructive/20 p-4 text-sm text-destructive"
        >
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <p>{localizeAuthError(error)}</p>
        </div>
      )}

      <ProfileSection />
      <HandleSection />
      <PasswordSection />
      <PreferencesSection />
      <TwoFactorSection />
      <PasskeySection />
      <LinkedAccountsSection />
      <SignOutSection />
    </div>
  );
}
