import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import {
  claimWelcomeFieldsAtom,
  dateOfBirthDraftAtom,
  handleDraftAtom,
  resetHandleClaimAtom,
  welcomeValidationAtom,
} from "@/atoms/handle-claim";
import { isSignedInAtom, needsDobAtom, needsHandleAtom, sessionPendingAtom } from "@/atoms/session";
import { offerTwoFactorAtom } from "@/atoms/onboarding";
import {
  openTwoFactorPanelAtom,
  startTwoFactorSetupAtom,
  twoFactorCodeAtom,
  twoFactorPanelAtom,
  twoFactorPasswordAtom,
  twoFactorSetupAtom,
  verifyTwoFactorAtom,
} from "@/atoms/two-factor";
import { useRedirectWhenSignedIn } from "@/hooks/use-redirect-when-signed-in";
import { localizeAuthError } from "@/lib/auth-error-message";
import { ErrorBanner } from "@/components/error-banner";
import { PageCard } from "@/components/page-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AtSign, Calendar, Check, Loader2, ShieldCheck } from "lucide-react";
import QRCode from "react-qr-code";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/welcome")({
  component: WelcomePage,
});

/**
 * Where a sign-up finishes becoming a complete account.
 *
 * OAuth gives us a name, an email and an avatar but no handle — and this app's
 * profile URLs, follow lists and `user.byUsername` lookups are all keyed on
 * one. And every account must declare a date of birth to stand against the
 * 15+ rule (see `needsDobAtom`), which a social sign-up and any pre-rule
 * account has not done. `useRequireHandle` (mounted in `__root.tsx`) sends any
 * incomplete session here and keeps it here; this is the page that lets it
 * leave. Each field renders only when that half of the session is missing.
 */
function WelcomePage() {
  const navigate = useNavigate();
  const isSignedIn = useAtomValue(isSignedInAtom);
  const isSessionPending = useAtomValue(sessionPendingAtom);

  /**
   * This is the whole exit from this page, and it is reused rather than
   * reimplemented on purpose.
   *
   * `useRedirectWhenSignedIn` sends a session that *has* a handle to its
   * profile, and one that doesn't to `/welcome` — a no-op while we're already
   * here. So it covers both reasons to leave with one rule: arriving with a
   * handle already (a bookmark, a back button), and claiming one just now.
   *
   * The first version of this page navigated from the submit handler *and*
   * ran a separate `!needsHandle → "/"` guard. Both fired the instant the
   * claim landed and the guard won, dropping people on the home feed instead
   * of their new profile. That is the same double-navigation race
   * `register.tsx` had, and the fix is the same one: exactly one effect owns
   * the redirect, and actions only change the session.
   */
  useRedirectWhenSignedIn();

  /**
   * The one case the hook above can't cover — it only acts on sessions that
   * exist. Someone signed out who types this URL has nothing to claim.
   *
   * `isSessionPending` first, and that matters: `isSignedInAtom` reads false
   * while BetterAuth's first `/get-session` is still in flight, so on a cold
   * load this would fire against a session that simply hasn't arrived yet and
   * eject a signed-in person to `/login`.
   */
  useEffect(() => {
    if (isSessionPending) return;
    if (!isSignedIn) void navigate({ to: "/login", replace: true });
  }, [isSessionPending, isSignedIn, navigate]);

  const needsHandle = useAtomValue(needsHandleAtom);
  const needsDob = useAtomValue(needsDobAtom);
  const offerTwoFactor = useAtomValue(offerTwoFactorAtom);

  /**
   * The two steps are sequential, not simultaneous. Missing fields always win:
   * an account without a handle cannot be rendered at all, so asking it about
   * two-factor first would be asking a question on top of a broken state — and
   * `useRequireHandle` would still be holding the session here regardless.
   *
   * Once the fields are in, this component re-renders with `needsHandle` and
   * `needsDob` false and the offer takes over. Nothing navigates in between,
   * which is what keeps this one page rather than two.
   */
  const needsFields = needsHandle || needsDob;

  const [handle, setHandle] = useAtom(handleDraftAtom);
  const [dateOfBirth, setDateOfBirth] = useAtom(dateOfBirthDraftAtom);
  const validationError = useAtomValue(welcomeValidationAtom);
  const [error, setError] = useAtom(authErrorAtom);
  const isSubmitting = useAtomValue(authPendingAtom);
  const claimWelcomeFields = useSetAtom(claimWelcomeFieldsAtom);

  // Same lifetime rule as the auth forms (see atoms/auth-form.ts): reset on
  // unmount rather than scoping with a nested Provider, which would give this
  // subtree its own empty store and break the session reads above.
  const resetForm = useSetAtom(resetHandleClaimAtom);
  useEffect(() => resetForm, [resetForm]);

  // The enrolment panel is shared with /settings/account, so leaving it open
  // here would greet the next visit to either page mid-flow, with a password
  // field and no explanation.
  const closeTwoFactorPanel = useSetAtom(openTwoFactorPanelAtom);
  useEffect(() => () => closeTwoFactorPanel("idle"), [closeTwoFactorPanel]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (validationError) {
      setError(validationError);
      return;
    }

    // Deliberately does not navigate — see `useRedirectWhenSignedIn` above.
    await claimWelcomeFields();
  };

  /**
   * Nothing missing and no offer outstanding — this page has no business
   * rendering. `useRedirectWhenSignedIn` above is already moving them to their
   * profile; returning null is what stops the two-factor offer flashing up for
   * a frame at somebody who merely typed `/welcome` into the address bar.
   */
  if (!needsFields && !offerTwoFactor) return null;

  const title = needsFields
    ? needsHandle
      ? m.welcome_title()
      : m.welcome_dob_title()
    : m.welcome_2fa_title();
  const subtitle = needsFields
    ? needsHandle
      ? m.welcome_subtitle()
      : m.welcome_dob_subtitle()
    : m.welcome_2fa_subtitle();

  return (
    <div className="container max-w-md mx-auto px-4 py-12">
      <PageCard className="space-y-6">
        <div className="text-center space-y-2">
          {/* An account that already has its handle (it predates the 15+ rule)
              is here for the date of birth alone, and "Pick your handle" would
              describe a field the page does not render. The same applies once
              both are in and only the two-factor offer is left. */}
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>

        {error && (
          <ErrorBanner
            title={needsHandle ? m.welcome_claim_failed() : m.welcome_dob_claim_failed()}
            message={localizeAuthError(error)}
          />
        )}

        {!needsFields && <TwoFactorOffer />}

        {needsFields && (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {needsHandle && (
            <div className="space-y-2">
              <label
                htmlFor="handle"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {m.auth_field_username()}
              </label>
              <div className="relative">
                <AtSign className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="handle"
                  type="text"
                  placeholder={m.auth_field_username_placeholder()}
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  className="pl-10 h-10 bg-background/50"
                  autoComplete="username"
                  autoFocus
                  required
                />
              </div>
              <p className="text-xs text-muted-foreground">{m.welcome_handle_hint()}</p>
            </div>
          )}

          {needsDob && (
            <div className="space-y-2">
              <label
                htmlFor="dateOfBirth"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {m.auth_field_date_of_birth()}
              </label>
              <div className="relative">
                <Calendar className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="dateOfBirth"
                  type="date"
                  value={dateOfBirth}
                  onChange={(e) => setDateOfBirth(e.target.value)}
                  className="pl-10 h-10 bg-background/50"
                  autoComplete="bday"
                  required
                />
              </div>
              <p className="text-xs text-muted-foreground">{m.welcome_dob_hint()}</p>
            </div>
          )}

          <Button
            type="submit"
            className="w-full h-11 text-base font-medium rounded-2xl gap-2 mt-2"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{m.welcome_claiming()}</span>
              </>
            ) : (
              <>
                <Check className="h-4 w-4" />
                <span>{needsHandle ? m.welcome_claim() : m.welcome_dob_claim()}</span>
              </>
            )}
          </Button>
        </form>
        )}
      </PageCard>
    </div>
  );
}

/**
 * The skippable two-factor step, shown once, right after a sign-up completes.
 *
 * Every atom here is the one `/settings/account` already uses — enrolment is
 * the same three calls in the same order, and duplicating them would mean two
 * implementations of "generate a secret, show the QR, confirm a code" that
 * could drift. Only the chrome differs: an onboarding card with a Skip, rather
 * than a settings row with a toggle.
 *
 * The password has to be typed again even though it was typed a moment ago on
 * `/register`. `registerPasswordAtom` is reset when that route unmounts (see
 * atoms/auth-form.ts), and keeping a plaintext password alive across a
 * navigation to avoid one field would be the wrong trade — re-confirming
 * identity before enrolling a second factor is what the settings page does too.
 */
function TwoFactorOffer() {
  const dismiss = useSetAtom(offerTwoFactorAtom);
  const panel = useAtomValue(twoFactorPanelAtom);
  const openPanel = useSetAtom(openTwoFactorPanelAtom);
  const [password, setPassword] = useAtom(twoFactorPasswordAtom);
  const [code, setCode] = useAtom(twoFactorCodeAtom);
  const setup = useAtomValue(twoFactorSetupAtom);
  const isBusy = useAtomValue(authPendingAtom);

  const startSetup = useSetAtom(startTwoFactorSetupAtom);
  const verify = useSetAtom(verifyTwoFactorAtom);

  /**
   * Clearing the flag is the entire exit from this step, for both outcomes.
   * `useRedirectWhenSignedIn` — mounted by the page above — is watching it, so
   * dropping it lets that effect fall through to its normal rule and send the
   * person to their profile. Navigating from here instead would reintroduce
   * exactly the double-navigation race the page's own comment warns about.
   */
  const finish = () => dismiss(false);

  const handleEnable = async () => {
    if (await startSetup()) openPanel("verify");
  };

  const handleVerify = async () => {
    if (await verify("totp")) finish();
  };

  return (
    <div className="space-y-4">
      {panel === "idle" && (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-2xl border border-border/50 bg-background/40 p-4">
            <ShieldCheck className="h-5 w-5 shrink-0 text-primary mt-0.5" />
            <p className="text-xs text-muted-foreground">{m.twofa_section_off()}</p>
          </div>
          <Button
            type="button"
            className="w-full h-11 text-base font-medium rounded-2xl gap-2"
            onClick={() => openPanel("enable")}
          >
            <ShieldCheck className="h-4 w-4" />
            <span>{m.welcome_2fa_setup()}</span>
          </Button>
          {/* A real button, not a muted link: skipping is a legitimate,
              expected answer, and burying it would make this a gate rather
              than an offer. */}
          <Button
            type="button"
            variant="ghost"
            className="w-full rounded-2xl"
            onClick={finish}
          >
            {m.welcome_2fa_skip()}
          </Button>
        </div>
      )}

      {panel === "enable" && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleEnable();
          }}
        >
          <div className="space-y-2">
            <label
              htmlFor="welcome-twofa-password"
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {m.auth_field_password()}
            </label>
            <Input
              id="welcome-twofa-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="h-10 bg-background/50"
              autoFocus
              required
            />
            <p className="text-xs text-muted-foreground">{m.twofa_password_hint()}</p>
          </div>
          <Button
            type="submit"
            className="w-full h-11 text-base font-medium rounded-2xl gap-2"
            disabled={isBusy}
          >
            {isBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{m.welcome_2fa_setup()}</span>
          </Button>
          <Button type="button" variant="ghost" className="w-full rounded-2xl" onClick={finish}>
            {m.welcome_2fa_skip()}
          </Button>
        </form>
      )}

      {panel === "verify" && setup && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">{m.twofa_scan_hint()}</p>
          {/* White plate regardless of theme — scanners need the light modules
              lighter than the dark ones, same as /settings/account. */}
          <div className="bg-white p-4 rounded-2xl w-fit mx-auto">
            <QRCode value={setup.totpURI} size={160} />
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
              <label
                htmlFor="welcome-twofa-code"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {m.twofa_field_code()}
              </label>
              <Input
                id="welcome-twofa-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                inputMode="numeric"
                className="h-10 bg-background/50 font-mono tracking-[0.3em]"
                autoFocus
                required
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11 text-base font-medium rounded-2xl gap-2"
              disabled={isBusy}
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              <span>{m.twofa_confirm()}</span>
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
