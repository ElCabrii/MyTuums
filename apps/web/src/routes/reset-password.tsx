import { createFileRoute, Link } from "@tanstack/react-router";
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
import { useSignOut } from "@/hooks/use-sign-out";
import { localizeAuthError } from "@/lib/auth-error-message";
import { ErrorBanner } from "@/components/error-banner";
import { PageCard } from "@/components/page-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Lock } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { z } from "zod";
import { pageHead } from "@/lib/document-head";

export const Route = createFileRoute("/reset-password")({
  head: () =>
    pageHead(m.auth_reset_title(), m.reset_password_document_description(), "/reset-password"),
  component: ResetPasswordPage,
  /**
   * Two params, and both arrive from *outside*: BetterAuth's own server
   * appends them when it validates the token from the email link — `?token=`
   * on success, `?error=INVALID_TOKEN` on a bad or expired one — and redirects
   * the browser here. Same narrowing rule as /login's `?error=`: narrowed to a
   * string, never trusted.
   */
  validateSearch: (search) => resetPasswordSearchSchema.parse(search),
});

const resetPasswordSearchSchema = z.object({
  token: z.string().optional(),
  error: z.string().optional(),
});

/** The two params BetterAuth's reset-password redirect carries, both optional. */

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
  const handleSignOut = useSignOut();

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
    <div className="container mx-auto max-w-md px-4 py-12">
      <PageCard className="space-y-6">
        {done ? (
          <>
            <div className="space-y-2 text-center">
              <CheckCircle2 className="text-primary mx-auto h-8 w-8" />
              <h1 className="text-2xl font-bold tracking-tight">{m.auth_reset_success_title()}</h1>
              <p className="text-muted-foreground text-sm">{m.auth_reset_success_hint()}</p>
            </div>

            <Button
              className="h-11 w-full gap-2 rounded-2xl text-base font-medium"
              onClick={() => {
                // The reset revoked every session server-side
                // (`revokeSessionsOnPasswordReset`), so a stale client-side
                // session would bounce /login's `useRedirectWhenSignedIn`
                // straight back to a profile the server no longer lets it
                // read. `useSignOut` settles the store (and clears viewer
                // state) before navigating; it is a no-op when there was no
                // session.
                void handleSignOut();
              }}
            >
              <KeyRound className="h-4 w-4" />
              <span>{m.auth_log_in()}</span>
            </Button>
          </>
        ) : showInvalidLink ? (
          <>
            <div className="space-y-2 text-center">
              <AlertCircle className="text-destructive mx-auto h-8 w-8" />
              <h1 className="text-2xl font-bold tracking-tight">{m.auth_reset_invalid_title()}</h1>
              <p className="text-muted-foreground text-sm">{m.auth_reset_invalid_hint()}</p>
            </div>

            <Button
              className="h-11 w-full gap-2 rounded-2xl text-base font-medium"
              nativeButton={false}
              render={<Link to="/forgot-password" className="gap-2" />}
            >
              <KeyRound className="h-4 w-4" />
              <span>{m.auth_reset_request_new()}</span>
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-2 text-center">
              <KeyRound className="text-primary mx-auto h-8 w-8" />
              <h1 className="text-2xl font-bold tracking-tight">{m.auth_reset_title()}</h1>
              <p className="text-muted-foreground text-sm">{m.auth_reset_subtitle()}</p>
            </div>

            {error && (
              <ErrorBanner title={m.auth_reset_failed()} message={localizeAuthError(error)} />
            )}

            <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="new-password"
                  className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
                >
                  {m.auth_field_new_password()}
                </label>
                <div className="relative">
                  <Lock className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
                  <Input
                    id="new-password"
                    type="password"
                    placeholder="••••••••"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="bg-background/50 h-10 pl-10"
                    autoComplete="new-password"
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="confirm-password"
                  className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
                >
                  {m.auth_field_confirm_password()}
                </label>
                <div className="relative">
                  <Lock className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
                  <Input
                    id="confirm-password"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="bg-background/50 h-10 pl-10"
                    autoComplete="new-password"
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
