import { useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import {
  authErrorAtom,
  authPendingAtom,
  resendVerificationEmailAtom,
  verifyEmailAtom,
  verifyEmailSentAtom,
} from "@/atoms/auth";
import { resetVerifyEmailFormAtom } from "@/atoms/auth-form";
import { useRedirectWhenSignedIn } from "@/hooks/use-redirect-when-signed-in";
import { localizeAuthError } from "@/lib/auth-error-message";
import { ErrorBanner } from "@/components/error-banner";
import { PageCard } from "@/components/page-card";
import { Button } from "@/components/ui/button";
import { AlertCircle, MailCheck, Loader2, Mail } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { z } from "zod";
import { pageHead } from "@/lib/document-head";

export const Route = createFileRoute("/verify-email")({
  head: () => pageHead(m.auth_verify_title()),
  component: VerifyEmailPage,
  /**
   * `error` arrives from *outside*: Better Auth's `/verify-email` endpoint
   * appends `?error=<code>` (`TOKEN_EXPIRED`, `INVALID_TOKEN`,
   * `USER_NOT_FOUND`, `INVALID_USER`) to the callbackURL when a verification
   * link is bad, and redirects the browser here. Narrowed to a string, never
   * trusted — and every code maps to the same generic message below, so the
   * page cannot become an account-existence oracle (issue #172).
   */
  validateSearch: (search) => verifyEmailSearchSchema.parse(search),
});

const verifyEmailSearchSchema = z.object({
  error: z.string().optional(),
  /**
   * The pre-login destination, carried from `/login` or `/register` so the
   * trip survives email verification: this page hands it to
   * `useRedirectWhenSignedIn`, and the resend puts it back in the
   * verification link's `callbackURL` so a link opened in a *different*
   * browser still lands the person where they were headed. Sanitized at every
   * use by `lib/redirect.ts` — it arrives in the URL and is never trusted.
   */
  redirect: z.string().optional(),
});

/**
 * The check-your-email screen for a password sign-up awaiting verification
 * (issue #172), and the landing page for a clicked verification link.
 *
 * Three states, decided from the session and the `?error=` param:
 *
 * - **Signed in** — a verification link that succeeded. Better Auth's
 *   `autoSignInAfterVerification` created the session and redirected here, so
 *   `useRedirectWhenSignedIn` sends the person on to their profile (a password
 *   sign-up already has a handle and date of birth, so there is no `/welcome`
 *   stop). This is the only state that leaves the page.
 * - **`?error=`** — a verification link that failed (expired, already used, or
 *   invalid). A generic invalid/expired panel; the recovery path is to sign in,
 *   which re-sends the verification email via `sendOnSignIn` (the address is
 *   not known on this fresh link arrival, so there is no resend button here).
 * - **Pending** — reached right after sign-up, with `verifyEmailAtom` holding
 *   the address just entered. Shows the check-your-email copy and a rate-limited
 *   resend. A reload drops the atom and leaves the copy without a resend.
 *
 * `/verify-email` is in `SIGNED_OUT_PATHS` so the signed-in gates do not bounce
 * the pending and error states to `/login` before this page can render them.
 */
export function VerifyEmailPage() {
  const { error: linkError, redirect: redirectFromSearch } = Route.useSearch();
  // A signed-in arrival is a successful verification — hand navigation to the
  // shared redirect effect rather than navigating here. The destination rides
  // along so a person who was sent to `/login` from a protected page still
  // gets there once verified, the same way `/two-factor` carries it.
  useRedirectWhenSignedIn(redirectFromSearch);

  const email = useAtomValue(verifyEmailAtom);
  const sent = useAtomValue(verifyEmailSentAtom);
  const isSubmitting = useAtomValue(authPendingAtom);
  const error = useAtomValue(authErrorAtom);
  const resend = useSetAtom(resendVerificationEmailAtom);

  // See auth-form.ts: resetting on unmount is what bounds this page's share of
  // the auth atoms. Without it a failed resend stays in `authErrorAtom`, and
  // "Back to sign in" renders it as a sign-in error on a form nobody has
  // submitted yet. `verifyEmailAtom` deliberately survives — it belongs to the
  // sign-up in progress, not to this page.
  const resetForm = useSetAtom(resetVerifyEmailFormAtom);
  useEffect(() => resetForm, [resetForm]);

  if (linkError) {
    return (
      <div className="container mx-auto max-w-md px-4 py-12">
        <PageCard className="space-y-6">
          <div className="space-y-2 text-center">
            <AlertCircle className="text-destructive mx-auto h-8 w-8" />
            <h1 className="text-2xl font-bold tracking-tight">{m.auth_verify_invalid_title()}</h1>
            <p className="text-muted-foreground text-sm">{m.auth_verify_invalid_hint()}</p>
          </div>

          <Button
            className="h-11 w-full gap-2 rounded-2xl text-base font-medium"
            nativeButton={false}
            render={<Link to="/login" className="gap-2" />}
          >
            <Mail className="h-4 w-4" />
            <span>{m.auth_verify_back_to_login()}</span>
          </Button>
        </PageCard>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-md px-4 py-12">
      <PageCard className="space-y-6">
        <div className="space-y-2 text-center">
          <MailCheck className="text-primary mx-auto h-8 w-8" />
          <h1 className="text-2xl font-bold tracking-tight">{m.auth_verify_title()}</h1>
          <p className="text-muted-foreground text-sm">{m.auth_verify_subtitle()}</p>
        </div>

        {sent && (
          <p className="text-muted-foreground text-center text-sm">{m.auth_verify_sent()}</p>
        )}

        {error && <ErrorBanner title={m.auth_verify_title()} message={localizeAuthError(error)} />}

        {email && (
          <Button
            type="button"
            className="h-11 w-full gap-2 rounded-2xl text-base font-medium"
            disabled={isSubmitting}
            onClick={() => void resend({ email, redirect: redirectFromSearch })}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{m.auth_verify_resending()}</span>
              </>
            ) : (
              <>
                <Mail className="h-4 w-4" />
                <span>{m.auth_verify_resend()}</span>
              </>
            )}
          </Button>
        )}

        <div className="text-muted-foreground border-border/40 border-t pt-2 text-center text-xs">
          <Link to="/login" className="text-link font-medium hover:underline">
            {m.auth_verify_back_to_login()}
          </Link>
        </div>
      </PageCard>
    </div>
  );
}
