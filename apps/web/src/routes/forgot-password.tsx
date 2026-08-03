import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  authErrorAtom,
  authPendingAtom,
  forgotPasswordSentAtom,
  requestPasswordResetAtom,
} from "@/atoms/auth";
import {
  forgotPasswordEmailAtom,
  forgotPasswordValidationAtom,
  resetForgotPasswordFormAtom,
} from "@/atoms/auth-form";
import { useRedirectWhenSignedIn } from "@/hooks/use-redirect-when-signed-in";
import { localizeAuthError } from "@/lib/auth-error-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle, CheckCircle2, Loader2, Mail } from "lucide-react";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  // Same as /login: there is no reason to be here with a live session.
  useRedirectWhenSignedIn();

  const [email, setEmail] = useAtom(forgotPasswordEmailAtom);
  const validationError = useAtomValue(forgotPasswordValidationAtom);
  const [error, setError] = useAtom(authErrorAtom);
  const isSubmitting = useAtomValue(authPendingAtom);
  const sent = useAtomValue(forgotPasswordSentAtom);
  const requestReset = useSetAtom(requestPasswordResetAtom);

  // See auth-form.ts: resetting on unmount is what bounds these atoms'
  // lifetime to this page.
  const resetForm = useSetAtom(resetForgotPasswordFormAtom);
  useEffect(() => resetForm, [resetForm]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (validationError) {
      setError(validationError);
      return;
    }

    // No navigation on success — the sent flag swaps the form for the "check
    // your email" panel. The server answers `{status: true}` for unknown
    // emails too, so the panel never reveals whether the account exists.
    await requestReset(email);
  };

  return (
    <div className="container max-w-md mx-auto px-4 py-12">
      <div className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 sm:p-8 shadow-2xl space-y-6">
        {sent ? (
          <>
            <div className="text-center space-y-2">
              <CheckCircle2 className="h-8 w-8 mx-auto text-primary" />
              <h1 className="text-2xl font-bold tracking-tight">
                {m.auth_forgot_check_email_title()}
              </h1>
              <p className="text-sm text-muted-foreground">{m.auth_forgot_check_email_hint()}</p>
            </div>

            <Button
              className="w-full h-11 text-base font-medium rounded-2xl gap-2"
              nativeButton={false}
              render={<Link to="/login" className="gap-2" />}
            >
              <Mail className="h-4 w-4" />
              <span>{m.auth_forgot_back_to_login()}</span>
            </Button>
          </>
        ) : (
          <>
            <div className="text-center space-y-2">
              <Mail className="h-8 w-8 mx-auto text-primary" />
              <h1 className="text-2xl font-bold tracking-tight">{m.auth_forgot_title()}</h1>
              <p className="text-sm text-muted-foreground">{m.auth_forgot_subtitle()}</p>
            </div>

            {error && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-2xl bg-destructive/10 border border-destructive/20 p-4 text-sm text-destructive"
              >
                <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">{m.auth_forgot_failed()}</p>
                  <p className="text-destructive/90 text-xs mt-0.5">{localizeAuthError(error)}</p>
                </div>
              </div>
            )}

            <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="email"
                  className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {m.auth_field_email()}
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder={m.auth_field_email_placeholder()}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="pl-10 h-10 bg-background/50"
                    autoComplete="email"
                    required
                  />
                </div>
              </div>

              <Button
                type="submit"
                className="w-full h-11 text-base font-medium rounded-2xl gap-2 mt-2"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>{m.auth_forgot_sending()}</span>
                  </>
                ) : (
                  <>
                    <Mail className="h-4 w-4" />
                    <span>{m.auth_forgot_submit()}</span>
                  </>
                )}
              </Button>
            </form>

            <div className="text-center text-xs text-muted-foreground pt-2 border-t border-border/40">
              <Link to="/login" className="font-medium text-primary hover:underline">
                {m.auth_forgot_back_to_login()}
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
