import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, LockKeyhole, ShieldCheck, SlidersHorizontal, UserRound } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { handleOf } from "@/lib/user";
import { useAtomValue, useSetAtom } from "jotai";
import { authErrorAtom } from "@/atoms/auth";
import { viewerAtom } from "@/atoms/session";
import { openTwoFactorPanelAtom } from "@/atoms/two-factor";
import { resetPasskeyFormsAtom } from "@/atoms/passkey";
import { localizeAuthError } from "@/lib/auth-error-message";
import { ErrorBanner } from "@/components/error-banner";
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

export function AccountSettingsPage() {
  const viewer = useAtomValue(viewerAtom);
  const error = useAtomValue(authErrorAtom);
  const setError = useSetAtom(authErrorAtom);

  const resetPasskeyForms = useSetAtom(resetPasskeyFormsAtom);
  const closePanel = useSetAtom(openTwoFactorPanelAtom);
  useEffect(() => {
    setError(null);
    return () => {
      resetPasskeyForms();
      closePanel("idle");
      setError(null);
    };
  }, [resetPasskeyForms, closePanel, setError]);

  if (!viewer) return null;

  const handle = handleOf(viewer);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="space-y-4">
        {handle && (
          <Link
            to="/@{$username}"
            params={{ username: handle }}
            className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-2 text-sm"
          >
            <ArrowLeft className="size-4" />
            {m.settings_back_to_profile()}
          </Link>
        )}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">{m.settings_title()}</h1>
          <p className="text-muted-foreground text-sm">{m.settings_subtitle()}</p>
        </div>
      </div>

      <Tabs defaultValue="account" onValueChange={() => setError(null)} className="gap-6">
        <TabsList
          aria-label={m.settings_title()}
          className="grid w-full grid-cols-2 gap-1 rounded-2xl p-1 group-data-horizontal/tabs:h-auto sm:flex sm:rounded-full"
        >
          <TabsTrigger value="account" className="h-11 gap-2">
            <UserRound className="hidden size-4 sm:block" />
            {m.settings_group_account()}
          </TabsTrigger>
          <TabsTrigger value="security" className="h-11 gap-2">
            <LockKeyhole className="hidden size-4 sm:block" />
            {m.settings_group_security()}
          </TabsTrigger>
          <TabsTrigger value="privacy" className="h-11 gap-2">
            <ShieldCheck className="hidden size-4 sm:block" />
            {m.settings_group_privacy()}
          </TabsTrigger>
          <TabsTrigger value="preferences" className="h-11 gap-2">
            <SlidersHorizontal className="hidden size-4 sm:block" />
            {m.settings_group_preferences()}
          </TabsTrigger>
        </TabsList>
        {error && <ErrorBanner message={localizeAuthError(error)} />}
        <TabsContent value="account" keepMounted className="space-y-5">
          <h2 className="font-semibold">{m.settings_account_intro()}</h2>
          <div className="bg-muted/40 rounded-2xl border p-4">
            <p className="text-muted-foreground text-xs">{m.auth_field_email()}</p>
            <p className="mt-1 text-sm font-medium break-all">{viewer.email}</p>
          </div>
          <HandleSection />
          <LinkedAccountsSection />
          <SignOutSection />
        </TabsContent>
        <TabsContent value="security" keepMounted className="space-y-5">
          <h2 className="font-semibold">{m.settings_security_intro()}</h2>
          <PasswordSection />
          <TwoFactorSection />
          <PasskeySection />
        </TabsContent>
        <TabsContent value="privacy" keepMounted className="space-y-5">
          <h2 className="font-semibold">{m.settings_privacy_intro()}</h2>
          <PrivacySection />
          <FollowRequestsSection />
          <BlockedUsersSection />
          <AnalyticsSection />
        </TabsContent>
        <TabsContent value="preferences" keepMounted className="space-y-5">
          <h2 className="font-semibold">{m.settings_preferences_intro()}</h2>
          <PreferencesSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
