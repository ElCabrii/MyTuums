import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, type FormEvent } from "react";
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
import { ErrorBanner } from "@/components/error-banner";
import { PageCard } from "@/components/page-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
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
export function TwoFactorPage() {
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await verify(method);
  };

  const isBackup = method === "backup";

  return (
    <div className="container mx-auto max-w-md px-4 py-12">
      <PageCard className="space-y-6">
        <div className="space-y-2 text-center">
          <ShieldCheck className="text-primary mx-auto h-8 w-8" />
          <h1 className="text-2xl font-bold tracking-tight">{m.twofa_challenge_title()}</h1>
          <p className="text-muted-foreground text-sm">
            {isBackup
              ? m.twofa_challenge_backup_subtitle()
              : method === "otp"
                ? m.twofa_challenge_email_subtitle()
                : m.twofa_challenge_totp_subtitle()}
          </p>
        </div>

        {error && (
          <ErrorBanner title={m.twofa_challenge_failed()} message={localizeAuthError(error)} />
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="code"
              className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
            >
              {isBackup ? m.twofa_field_backup_code() : m.twofa_field_code()}
            </label>
            <div className="relative">
              <KeyRound className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
              <Input
                id="code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="bg-background/50 h-10 pl-10 font-mono tracking-[0.3em]"
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

          <label className="text-muted-foreground flex cursor-pointer items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={trustDevice}
              onChange={(e) => setTrustDevice(e.target.checked)}
              className="border-border accent-primary h-4 w-4 rounded"
            />
            <span>{m.twofa_trust_device()}</span>
          </label>

          <Button
            type="submit"
            className="mt-2 h-11 w-full gap-2 rounded-2xl text-base font-medium"
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

        <div className="border-border/40 space-y-2 border-t pt-2">
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

        <div className="text-muted-foreground text-center text-xs">
          <Link to="/login" className="text-link font-medium hover:underline">
            {m.twofa_back_to_login()}
          </Link>
        </div>
      </PageCard>
    </div>
  );
}
