import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, type FormEvent } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  authErrorAtom,
  authPendingAtom,
  resetPasswordAtom,
  resetPasswordDoneAtom,
  resetPasswordInvalidAtom,
} from "@/atoms/auth";
import {
  resetPasswordConfirmAtom,
  resetPasswordNewAtom,
  resetPasswordValidationAtom,
  resetResetPasswordFormAtom,
} from "@/atoms/auth-form";
import { signOut } from "@/lib/auth-client";
import { localizeAuthError } from "@/lib/auth-error-message";
import { ErrorBanner } from "@/components/error-banner";
import { PageCard } from "@/components/page-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Lock } from "lucide-react";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
  /**
   * Two params, and both arrive from *outside*: BetterAuth's own server
   * appends them when it validates the token from the email link — `?token=`
   * on success, `?error=INVALID_TOKEN` on a bad or expired one — and redirects
   * the browser here. Same narrowing rule as /login's `?error=`: narrowed to a
   * string, never trusted.
   */
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => ({
    ...(typeof search.token === "string" ? { token: search.token } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
});

/**
 * The token stage of a password reset.
 *
 * Unlike every other auth page this one deliberately does NOT use
 * `useRedirectWhenSignedIn`: resetting your own password from an email link is
 * legitimate while signed in, and the success path signs out anyway (the
 * server revokes every session on reset).
 *
 * One accepted quirk: after a successful reset, refreshing the page re-renders
 * against a consumed token and shows the invalid-link panel. Inherent to
 * single-use tokens, so there is nothing to fix — the person already has what
 * they came for.
 */
function ResetPasswordPage() {
  const { token, error: linkError } = Route.useSearch();
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useAtom(resetPasswordNewAtom);
  const [confirmPassword, setConfirmPassword] = useAtom(resetPasswordConfirmAtom);
  const validationError = useAtomValue(resetPasswordValidationAtom);
  const [error, setError] = useAtom(authErrorAtom);
  const isSubmitting = useAtomValue(authPendingAtom);
  const done = useAtomValue(resetPasswordDoneAtom);
  const invalid = useAtomValue(resetPasswordInvalidAtom);
  const reset = useSetAtom(resetPasswordAtom);

  // See auth-form.ts: resetting on unmount is what bounds these atoms'
  // lifetime to this page.
  const resetForm = useSetAtom(resetResetPasswordFormAtom);
  useEffect(() => resetForm, [resetForm]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (validationError) {
      setError(validationError);
      return;
    }
    if (!token) return;

    await reset({ token, newPassword });
  };

  // The link is dead when the server said so, when there is no token at all
  // (a direct visit, or a refresh after success), or when the server rejected
  // the token on submit.
  const showInvalidLink = done ? false : invalid || linkError === "INVALID_TOKEN" || !token;

  return (
    <div className="container max-w-md mx-auto px-4 py-12">
      <PageCard className="space-y-6">
        {done ? (
          <>
            <div className="text-center space-y-2">
              <CheckCircle2 className="h-8 w-8 mx-auto text-primary" />
              <h1 className="text-2xl font-bold tracking-tight">{m.auth_reset_success_title()}</h1>
              <p className="text-sm text-muted-foreground">{m.auth_reset_success_hint()}</p>
            </div>

            <Button
              className="w-full h-11 text-base font-medium rounded-2xl gap-2"
              onClick={() => {
                // The reset revoked every session server-side
                // (`revokeSessionsOnPasswordReset`), so a stale client-side
                // session would bounce /login's `useRedirectWhenSignedIn`
                // straight back to a profile the server no longer lets it
                // read. Signing out first settles the store; it is a no-op
                // when there was no session.
                void signOut().then(() => navigate({ to: "/login" }));
              }}
            >
              <KeyRound className="h-4 w-4" />
              <span>{m.auth_log_in()}</span>
            </Button>
          </>
        ) : showInvalidLink ? (
          <>
            <div className="text-center space-y-2">
              <AlertCircle className="h-8 w-8 mx-auto text-destructive" />
              <h1 className="text-2xl font-bold tracking-tight">{m.auth_reset_invalid_title()}</h1>
              <p className="text-sm text-muted-foreground">{m.auth_reset_invalid_hint()}</p>
            </div>

            <Button
              className="w-full h-11 text-base font-medium rounded-2xl gap-2"
              nativeButton={false}
              render={<Link to="/forgot-password" className="gap-2" />}
            >
              <KeyRound className="h-4 w-4" />
              <span>{m.auth_reset_request_new()}</span>
            </Button>
          </>
        ) : (
          <>
            <div className="text-center space-y-2">
              <KeyRound className="h-8 w-8 mx-auto text-primary" />
              <h1 className="text-2xl font-bold tracking-tight">{m.auth_reset_title()}</h1>
              <p className="text-sm text-muted-foreground">{m.auth_reset_subtitle()}</p>
            </div>

            {error && (
              <ErrorBanner title={m.auth_reset_failed()} message={localizeAuthError(error)} />
            )}

            <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="new-password"
                  className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {m.auth_field_new_password()}
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="new-password"
                    type="password"
                    placeholder="••••••••"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="pl-10 h-10 bg-background/50"
                    autoComplete="new-password"
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="confirm-password"
                  className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {m.auth_field_confirm_password()}
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="confirm-password"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="pl-10 h-10 bg-background/50"
                    autoComplete="new-password"
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
                    <span>{m.auth_reset_resetting()}</span>
                  </>
                ) : (
                  <>
                    <KeyRound className="h-4 w-4" />
                    <span>{m.auth_reset_submit()}</span>
                  </>
                )}
              </Button>
            </form>

            <div className="text-center text-xs text-muted-foreground pt-2 border-t border-border/40">
              <Link to="/login" className="font-medium text-link hover:underline">
                {m.auth_forgot_back_to_login()}
              </Link>
            </div>
          </>
        )}
      </PageCard>
    </div>
  );
}
