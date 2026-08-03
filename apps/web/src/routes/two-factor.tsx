import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { authErrorAtom, authPendingAtom, twoFactorMethodsAtom } from "@/atoms/auth";
import {
  resetTwoFactorChallengeAtom,
  selectTwoFactorMethodAtom,
  selectedTwoFactorMethodAtom,
  sendTwoFactorOtpAtom,
  trustDeviceAtom,
  twoFactorCodeAtom,
  verifyTwoFactorAtom,
} from "@/atoms/two-factor";
import { useRedirectWhenSignedIn } from "@/hooks/use-redirect-when-signed-in";
import { localizeAuthError } from "@/lib/auth-error-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle, KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/two-factor")({
  component: TwoFactorPage,
  /**
   * The `redirect` param lands here from `/login` when the person was in the
   * middle of a sign-in that needed a second factor — see login.tsx. After the
   * challenge succeeds and a real session appears, `useRedirectWhenSignedIn`
   * reads it back and finishes the trip to the page the gate had sent them
   * from. Direct hits have no param and behave as before.
   */
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
});

/**
 * The second-factor challenge.
 *
 * Reached from `/login` when the sign-in response carries `twoFactorRedirect`.
 * At this point there is **no session** — BetterAuth discards the pending one
 * and holds the challenge in its own cookie — so this page cannot read the
 * viewer, and `useRedirectWhenSignedIn` below is what finally moves on once a
 * real session is issued.
 */
function TwoFactorPage() {
  const { redirect: redirectFromSearch } = Route.useSearch();
  // The session only exists after a correct code, so this fires exactly once,
  // on success — the same effect that ends a normal sign-in.
  useRedirectWhenSignedIn(redirectFromSearch);

  const availableMethods = useAtomValue(twoFactorMethodsAtom);
  const method = useAtomValue(selectedTwoFactorMethodAtom);
  const selectMethod = useSetAtom(selectTwoFactorMethodAtom);
  const [code, setCode] = useAtom(twoFactorCodeAtom);
  const [trustDevice, setTrustDevice] = useAtom(trustDeviceAtom);
  const error = useAtomValue(authErrorAtom);
  const isSubmitting = useAtomValue(authPendingAtom);
  const verify = useSetAtom(verifyTwoFactorAtom);
  const sendOtp = useSetAtom(sendTwoFactorOtpAtom);

  const reset = useSetAtom(resetTwoFactorChallengeAtom);
  useEffect(() => reset, [reset]);

  // Empty when this page was reached directly rather than through a sign-in
  // (a reload, a bookmark). The challenge cookie is server-side and outlives
  // the atom, so the code still works — offering every method is the useful
  // response, not an error.
  const offersEmailCode = availableMethods.length === 0 || availableMethods.includes("otp");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await verify(method);
  };

  const isBackup = method === "backup";

  return (
    <div className="container max-w-md mx-auto px-4 py-12">
      <div className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <ShieldCheck className="h-8 w-8 mx-auto text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">{m.twofa_challenge_title()}</h1>
          <p className="text-sm text-muted-foreground">
            {isBackup
              ? m.twofa_challenge_backup_subtitle()
              : method === "otp"
                ? m.twofa_challenge_email_subtitle()
                : m.twofa_challenge_totp_subtitle()}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-2xl bg-destructive/10 border border-destructive/20 p-4 text-sm text-destructive"
          >
            <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{m.twofa_challenge_failed()}</p>
              <p className="text-destructive/90 text-xs mt-0.5">{localizeAuthError(error)}</p>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="code"
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {isBackup ? m.twofa_field_backup_code() : m.twofa_field_code()}
            </label>
            <div className="relative">
              <KeyRound className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="pl-10 h-10 bg-background/50 tracking-[0.3em] font-mono"
                // `one-time-code` lets iOS and Android offer the code straight
                // from the notification. Backup codes are not one-time-codes in
                // that sense and would only confuse the autofill heuristics.
                autoComplete={isBackup ? "off" : "one-time-code"}
                inputMode={isBackup ? "text" : "numeric"}
                autoFocus
                required
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={trustDevice}
              onChange={(e) => setTrustDevice(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span>{m.twofa_trust_device()}</span>
          </label>

          <Button
            type="submit"
            className="w-full h-11 text-base font-medium rounded-2xl gap-2 mt-2"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{m.twofa_verifying()}</span>
              </>
            ) : (
              <>
                <ShieldCheck className="h-4 w-4" />
                <span>{m.twofa_verify()}</span>
              </>
            )}
          </Button>
        </form>

        <div className="space-y-2 pt-2 border-t border-border/40">
          {method !== "otp" && offersEmailCode && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full gap-2 text-xs"
              disabled={isSubmitting}
              onClick={() => {
                selectMethod("otp");
                void sendOtp();
              }}
            >
              <Mail className="h-3.5 w-3.5" />
              <span>{m.twofa_use_email_code()}</span>
            </Button>
          )}
          {method !== "totp" && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs"
              disabled={isSubmitting}
              onClick={() => selectMethod("totp")}
            >
              {m.twofa_use_authenticator()}
            </Button>
          )}
          {!isBackup && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs"
              disabled={isSubmitting}
              onClick={() => selectMethod("backup")}
            >
              {m.twofa_use_backup_code()}
            </Button>
          )}
        </div>

        <div className="text-center text-xs text-muted-foreground">
          <Link to="/login" className="font-medium text-primary hover:underline">
            {m.twofa_back_to_login()}
          </Link>
        </div>
      </div>
    </div>
  );
}
