import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, type FormEvent } from "react";
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
import { ErrorBanner } from "@/components/error-banner";
import { PageCard } from "@/components/page-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Loader2, Mail } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";

export const Route = createFileRoute("/forgot-password")({
  head: () => pageHead(m.auth_forgot_title()),
  component: ForgotPasswordPage,
});

/**
 * The password-reset request page: collects the account email, then swaps the
 * form for a "check your email" panel that never reveals whether the account
 * exists.
 */
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

  const handleSubmit = async (e: FormEvent) => {
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
    <div className="container mx-auto max-w-md px-4 py-12">
      <PageCard className="space-y-6">
        {sent ? (
          <>
            <div className="space-y-2 text-center">
              <CheckCircle2 className="text-primary mx-auto h-8 w-8" />
              <h1 className="text-2xl font-bold tracking-tight">
                {m.auth_forgot_check_email_title()}
              </h1>
              <p className="text-muted-foreground text-sm">{m.auth_forgot_check_email_hint()}</p>
            </div>

            <Button
              className="h-11 w-full gap-2 rounded-2xl text-base font-medium"
              nativeButton={false}
              render={<Link to="/login" className="gap-2" />}
            >
              <Mail className="h-4 w-4" />
              <span>{m.auth_forgot_back_to_login()}</span>
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-2 text-center">
              <Mail className="text-primary mx-auto h-8 w-8" />
              <h1 className="text-2xl font-bold tracking-tight">{m.auth_forgot_title()}</h1>
              <p className="text-muted-foreground text-sm">{m.auth_forgot_subtitle()}</p>
            </div>

            {error && (
              <ErrorBanner title={m.auth_forgot_failed()} message={localizeAuthError(error)} />
            )}

            <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="email"
                  className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
                >
                  {m.auth_field_email()}
                </label>
                <div className="relative">
                  <Mail className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
                  <Input
                    id="email"
                    type="email"
                    placeholder={m.auth_field_email_placeholder()}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="bg-background/50 h-10 pl-10"
                    autoComplete="email"
                    required
                  />
                </div>
              </div>

              <Button
                type="submit"
                className="mt-2 h-11 w-full gap-2 rounded-2xl text-base font-medium"
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

            <div className="text-muted-foreground border-border/40 border-t pt-2 text-center text-xs">
              <Link to="/login" className="text-link font-medium hover:underline">
                {m.auth_forgot_back_to_login()}
              </Link>
            </div>
          </>
        )}
      </PageCard>
    </div>
  );
}
