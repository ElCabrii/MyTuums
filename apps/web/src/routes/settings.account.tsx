import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import QRCode from "react-qr-code";
import { authErrorAtom, authPendingAtom, signOutAtom } from "@/atoms/auth";
import { isSignedInAtom, sessionPendingAtom, viewerAtom } from "@/atoms/session";
import {
  disableTwoFactorAtom,
  openTwoFactorPanelAtom,
  startTwoFactorSetupAtom,
  twoFactorCodeAtom,
  twoFactorPanelAtom,
  twoFactorPasswordAtom,
  twoFactorSetupAtom,
  verifyTwoFactorAtom,
} from "@/atoms/two-factor";
import {
  addPasskeyAtom,
  deletePasskeyAtom,
  editingPasskeyIdAtom,
  newPasskeyNameAtom,
  passkeyNameDraftAtom,
  passkeysAtom,
  renamePasskeyAtom,
  resetPasskeyFormsAtom,
  startRenamingPasskeyAtom,
} from "@/atoms/passkey";
import {
  linkProviderAtom,
  linkedAccountsAtom,
  unlinkProviderAtom,
} from "@/atoms/linked-accounts";
import { socialProviders } from "@/lib/auth-client";
import { localizeAuthError } from "@/lib/auth-error-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertCircle,
  Check,
  Fingerprint,
  Link2,
  Loader2,
  LogOut,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
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

      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl bg-destructive/10 border border-destructive/20 p-4 text-sm text-destructive"
        >
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <p>{localizeAuthError(error)}</p>
        </div>
      )}

      <TwoFactorSection />
      <PasskeySection />
      <LinkedAccountsSection />
      <SignOutSection />
    </div>
  );
}

function Section({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 space-y-4">
      <div className="flex items-start gap-3">
        <div className="text-primary mt-0.5">{icon}</div>
        <div className="space-y-1">
          <h2 className="font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function TwoFactorSection() {
  const viewer = useAtomValue(viewerAtom);
  const panel = useAtomValue(twoFactorPanelAtom);
  const openPanel = useSetAtom(openTwoFactorPanelAtom);
  const [password, setPassword] = useAtom(twoFactorPasswordAtom);
  const [code, setCode] = useAtom(twoFactorCodeAtom);
  const setup = useAtomValue(twoFactorSetupAtom);
  const isBusy = useAtomValue(authPendingAtom);

  const startSetup = useSetAtom(startTwoFactorSetupAtom);
  const disable = useSetAtom(disableTwoFactorAtom);
  const verify = useSetAtom(verifyTwoFactorAtom);

  const enabled = Boolean(viewer?.twoFactorEnabled);

  const handleEnable = async () => {
    if (await startSetup()) openPanel("verify");
  };

  const handleVerify = async () => {
    // The same action the sign-in challenge uses — enrolment confirmation and
    // a login challenge post to the identical endpoint. BetterAuth only flips
    // `twoFactorEnabled` once one of them succeeds, which is what stops
    // somebody locking themselves out with a secret they never scanned.
    if (await verify("totp")) openPanel("idle");
  };

  const handleDisable = async () => {
    if (await disable()) openPanel("idle");
  };

  return (
    <Section
      title={m.twofa_section_title()}
      description={enabled ? m.twofa_section_on() : m.twofa_section_off()}
      icon={<ShieldCheck className="h-5 w-5" />}
    >
      {panel === "idle" && (
        <Button
          variant={enabled ? "outline" : "default"}
          size="sm"
          className="rounded-full"
          disabled={isBusy}
          onClick={() => openPanel(enabled ? "disable" : "enable")}
        >
          {enabled ? m.twofa_disable() : m.twofa_enable()}
        </Button>
      )}

      {(panel === "enable" || panel === "disable") && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void (panel === "enable" ? handleEnable() : handleDisable());
          }}
        >
          <div className="space-y-2">
            <label htmlFor="twofa-password" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {m.auth_field_password()}
            </label>
            <Input
              id="twofa-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="h-10 bg-background/50"
              required
            />
            <p className="text-xs text-muted-foreground">{m.twofa_password_hint()}</p>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="rounded-full gap-2" disabled={isBusy}>
              {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {panel === "enable" ? m.twofa_enable() : m.twofa_disable()}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => openPanel("idle")}>
              {m.common_cancel()}
            </Button>
          </div>
        </form>
      )}

      {panel === "verify" && setup && (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{m.twofa_scan_hint()}</p>
            {/* White plate regardless of theme: QR scanners need the light
                modules lighter than the dark ones, and a dark-mode card
                background behind a dark foreground is unreadable to them. */}
            <div className="bg-white p-4 rounded-2xl w-fit">
              <QRCode value={setup.totpURI} size={160} />
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {m.twofa_backup_codes()}
            </p>
            <p className="text-xs text-muted-foreground">{m.twofa_backup_codes_hint()}</p>
            <ul className="grid grid-cols-2 gap-1.5 font-mono text-xs bg-muted/40 rounded-2xl p-4">
              {setup.backupCodes.map((backupCode) => (
                <li key={backupCode}>{backupCode}</li>
              ))}
            </ul>
          </div>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleVerify();
            }}
          >
            <div className="space-y-2">
              <label htmlFor="twofa-code" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {m.twofa_field_code()}
              </label>
              <Input
                id="twofa-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                inputMode="numeric"
                className="h-10 bg-background/50 font-mono tracking-[0.3em]"
                required
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" className="rounded-full gap-2" disabled={isBusy}>
                {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {m.twofa_confirm()}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => openPanel("idle")}>
                {m.common_cancel()}
              </Button>
            </div>
          </form>
        </div>
      )}
    </Section>
  );
}

function PasskeySection() {
  const { data: passkeys, isPending } = useAtomValue(passkeysAtom);
  const [newName, setNewName] = useAtom(newPasskeyNameAtom);
  const [nameDraft, setNameDraft] = useAtom(passkeyNameDraftAtom);
  const editingId = useAtomValue(editingPasskeyIdAtom);
  const startRenaming = useSetAtom(startRenamingPasskeyAtom);
  const addPasskey = useSetAtom(addPasskeyAtom);
  const renamePasskey = useSetAtom(renamePasskeyAtom);
  const deletePasskey = useSetAtom(deletePasskeyAtom);
  const isBusy = useAtomValue(authPendingAtom);

  const handleAdd = async () => {
    if (await addPasskey(newName)) setNewName("");
  };

  return (
    <Section
      title={m.passkey_section_title()}
      description={m.passkey_section_description()}
      icon={<Fingerprint className="h-5 w-5" />}
    >
      {isPending ? (
        <p className="text-xs text-muted-foreground">{m.passkey_loading()}</p>
      ) : passkeys && passkeys.length > 0 ? (
        <ul className="space-y-2">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className="flex items-center gap-2 rounded-2xl border border-border/50 bg-background/40 px-4 py-2.5"
            >
              {editingId === passkey.id ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void renamePasskey({ id: passkey.id, name: nameDraft }).then(() =>
                      startRenaming(null),
                    );
                  }}
                >
                  <Input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    aria-label={m.passkey_name_label()}
                    className="h-8 bg-background/50"
                    autoFocus
                  />
                  <Button type="submit" size="icon" variant="ghost" aria-label={m.common_save()} disabled={isBusy}>
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={m.common_cancel()}
                    onClick={() => startRenaming(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </form>
              ) : (
                <>
                  <span className="flex-1 text-sm truncate">
                    {passkey.name || m.passkey_unnamed()}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    onClick={() => startRenaming(passkey)}
                  >
                    {m.passkey_rename()}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={m.passkey_delete_label({ name: passkey.name || m.passkey_unnamed() })}
                    disabled={isBusy}
                    onClick={() => void deletePasskey(passkey.id)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{m.passkey_empty()}</p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleAdd();
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={m.passkey_name_placeholder()}
          aria-label={m.passkey_name_label()}
          className="h-9 bg-background/50"
        />
        <Button type="submit" size="sm" className="rounded-full gap-2 shrink-0" disabled={isBusy}>
          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {m.passkey_add()}
        </Button>
      </form>
    </Section>
  );
}

function LinkedAccountsSection() {
  const { data: accounts, isPending } = useAtomValue(linkedAccountsAtom);
  const linkProvider = useSetAtom(linkProviderAtom);
  const unlinkProvider = useSetAtom(unlinkProviderAtom);
  const isBusy = useAtomValue(authPendingAtom);

  if (socialProviders.length === 0) return null;

  const linked = accounts ?? [];
  // Unlinking the only sign-in method would lock the account out. The server
  // refuses it too (FAILED_TO_UNLINK_LAST_ACCOUNT); this just means the button
  // is disabled rather than the error arriving after the click.
  const isLastMethod = linked.length <= 1;

  return (
    <Section
      title={m.settings_linked_title()}
      description={m.settings_linked_description()}
      icon={<Link2 className="h-5 w-5" />}
    >
      {isPending ? (
        <p className="text-xs text-muted-foreground">{m.settings_linked_loading()}</p>
      ) : (
        <ul className="space-y-2">
          {socialProviders.map((provider) => {
            const account = linked.find((a) => a.providerId === provider.id);
            return (
              <li
                key={provider.id}
                className="flex items-center gap-2 rounded-2xl border border-border/50 bg-background/40 px-4 py-2.5"
              >
                <span className="flex-1 text-sm">{provider.label}</span>
                {account ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs text-destructive"
                    disabled={isBusy || isLastMethod}
                    title={isLastMethod ? m.settings_linked_last_method() : undefined}
                    onClick={() =>
                      void unlinkProvider({
                        providerId: account.providerId,
                        accountId: account.accountId,
                      })
                    }
                  >
                    {m.settings_linked_unlink()}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    disabled={isBusy}
                    onClick={() => void linkProvider(provider.id)}
                  >
                    {m.settings_linked_link()}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function SignOutSection() {
  const navigate = useNavigate();
  const signOut = useSetAtom(signOutAtom);
  const isBusy = useAtomValue(authPendingAtom);

  return (
    <section className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 flex items-center justify-between gap-4">
      <div className="space-y-1">
        <h2 className="font-semibold">{m.auth_sign_out()}</h2>
        <p className="text-xs text-muted-foreground">{m.settings_sign_out_description()}</p>
      </div>
      <Button
        variant="destructive"
        size="sm"
        className="rounded-full gap-2 shrink-0"
        disabled={isBusy}
        onClick={() => {
          // `signOutAtom` waits for the session store to actually empty before
          // resolving (see lib/session-sync.ts), so this navigation cannot be
          // undone by a redirect effect reading a stale session.
          void signOut().then(() => navigate({ to: "/login" }));
        }}
      >
        {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
        <span>{m.auth_sign_out()}</span>
      </Button>
    </section>
  );
}
