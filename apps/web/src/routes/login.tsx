import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, type FormEvent } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { authErrorAtom, authPendingAtom, signInAtom } from "@/atoms/auth";
import {
  loginIdentifierAtom,
  loginPasswordAtom,
  loginValidationAtom,
  resetLoginFormAtom,
} from "@/atoms/auth-form";
import { useOneTap } from "@/hooks/use-one-tap";
import { useRedirectWhenSignedIn } from "@/hooks/use-redirect-when-signed-in";
import { localizeAuthError, localizeOAuthError } from "@/lib/auth-error-message";
import { ErrorBanner } from "@/components/error-banner";
import { PageCard } from "@/components/page-card";
import { SignInOptions } from "@/components/sign-in-options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogIn, Loader2, User, Lock } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { z } from "zod";
import { pageHead } from "@/lib/document-head";

export const Route = createFileRoute("/login")({
  head: () => pageHead(m.auth_log_in(), m.login_document_description(), "/login"),
  component: LoginPage,
  /**
   * Two search params, and together they prove the rule CONTEXT.md states:
   * view state belongs in an atom because a URL nobody can link to is the
   * cost. Neither of these is view state — each arrives from *outside*.
   *
   * `error` is handed back by an external redirect (BetterAuth's OAuth
   * callback appends `?error=<code>` to `errorCallbackURL`); `redirect` is
   * written by the site's own signed-in gate (`use-require-signed-in.ts`)
   * but read back from `window.location`, and it round-trips through the
   * provider during OAuth. A query param is the only channel either has, so
   * the exception stands.
   *
   * Both are narrowed to a string rather than trusted: they arrive from
   * outside, so anything else is dropped instead of being rendered — and
   * `redirect` is sanitized again in `lib/redirect.ts` before any navigation
   * honours it.
   *
   * `error_description` (issue #74) is deliberately NOT captured here even
   * though BetterAuth's OAuth callback appends one alongside `error`: it's
   * the server's raw, unlocalized English exception message, and every code
   * this page knows how to react to already has its own Paraglide copy
   * (`localizeOAuthError`, or the dedicated `/banned` screen for
   * `BANNED_USER`) that says the same thing in the viewer's language. Reading
   * it would only reintroduce the thing this issue removes — a
   * server-controlled English string surfacing in the UI — for codes that
   * fall through to the generic `auth_oauth_failed` message anyway.
   */
  validateSearch: (search) => loginSearchSchema.parse(search),
});

const loginSearchSchema = z.object({
  error: z.string().optional(),
  redirect: z.string().optional(),
});

/** The destination `/login` navigates to when a challenge is issued. */
interface TwoFactorDestination {
  to: "/two-factor";
  search?: { redirect: string };
}

/** The destination `/login` navigates to when the account's email is unverified. */
interface VerifyEmailDestination {
  to: "/verify-email";
  replace: boolean;
  search?: { redirect: string };
}

/**
 * The sign-in page: identifier + password form, the OAuth/passkey options, and
 * the `?error=` banner that surfaces a failed OAuth round trip. `?redirect=`
 * carries the pre-login destination (see `validateSearch` above).
 *
 * Exported (rather than kept file-private like most route bodies) so
 * `login.test.tsx` can mount it directly and drive the two banned-account
 * navigate sites it owns — the house pattern used by every other tested page
 * (see `not-found-page.test.tsx`).
 */
export function LoginPage() {
  // Both search params arrive from *outside* (see `validateSearch` above) —
  // read once, destructured.
  const { redirect: redirectFromSearch, error: oauthError } = Route.useSearch();
  useRedirectWhenSignedIn(redirectFromSearch);
  // No-op unless VITE_GOOGLE_CLIENT_ID is set — see lib/one-tap.ts.
  useOneTap();

  const navigate = useNavigate();
  const [identifier, setIdentifier] = useAtom(loginIdentifierAtom);
  const [password, setPassword] = useAtom(loginPasswordAtom);
  const validationError = useAtomValue(loginValidationAtom);
  const [error, setError] = useAtom(authErrorAtom);
  const isSubmitting = useAtomValue(authPendingAtom);
  const signIn = useSetAtom(signInAtom);

  // See auth-form.ts: resetting on unmount is what bounds these atoms'
  // lifetime to this page instead of a nested Provider (which would break
  // useRedirectWhenSignedIn's session read above).
  const resetForm = useSetAtom(resetLoginFormAtom);
  useEffect(() => resetForm, [resetForm]);

  /**
   * Surfaces a failed OAuth round trip in the same banner as every other auth
   * error, rather than leaving the person on a form that silently looks fine.
   *
   * Feeding `authErrorAtom` instead of rendering separately is what keeps
   * there to one error surface: submitting the password form afterwards
   * clears this the same way it clears any other message.
   *
   * `BANNED_USER` (issue #74) is the one code that does NOT go through the
   * banner: a banned account isn't "try again", so this navigates to the
   * dedicated `/banned` screen instead — `replace: true` so the address bar's
   * `?error=BANNED_USER` never lingers and the back button can't return to it.
   */
  useEffect(() => {
    if (!oauthError) return;
    if (oauthError === "BANNED_USER") {
      void navigate({ to: "/banned", replace: true });
      return;
    }
    setError(localizeOAuthError(oauthError));
  }, [oauthError, setError, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (validationError) {
      setError(validationError);
      return;
    }

    const outcome = await signIn({ identifier, password });

    // A correct password on a 2FA account produces no session — BetterAuth
    // issues a challenge instead — so `useRedirectWhenSignedIn` above will
    // never fire and this is the only thing that moves the person forward.
    // Signing in normally still redirects through that effect, not here, which
    // is what keeps the two paths from racing each other.
    if (outcome.status === "two-factor") {
      // The redirect param rides along so that after the challenge, when the
      // session finally appears, useRedirectWhenSignedIn (reading /two-factor's
      // own search) still knows where the person was heading.
      const destination: TwoFactorDestination = { to: "/two-factor" };
      if (redirectFromSearch) destination.search = { redirect: redirectFromSearch };
      void navigate(destination);
      return;
    }

    // See `SignInOutcome`'s docblock (atoms/auth.ts): a banned account gets
    // the dedicated screen instead of the form's error banner (issue #74).
    if (outcome.status === "banned") {
      void navigate({ to: "/banned", replace: true });
      return;
    }

    // The unverified-account recovery path (issue #172): a correct password on
    // an account whose email was never verified. Better Auth rejected the
    // sign-in (no session) and `sendOnSignIn` has already re-sent the
    // verification email, so send the person to the check-your-email screen
    // rather than a "try again" banner. `signInAtom` set `verifyEmailAtom`
    // when the identifier was an email, so the resend button is available then.
    if (outcome.status === "verify-email") {
      // The destination rides along, same as the `/two-factor` branch above:
      // this person was sent to `/login` from somewhere, and verifying their
      // email should not lose the trip.
      const destination: VerifyEmailDestination = { to: "/verify-email", replace: true };
      if (redirectFromSearch) destination.search = { redirect: redirectFromSearch };
      void navigate(destination);
    }
  };

  return (
    <div className="container mx-auto max-w-md px-4 py-12">
      <PageCard className="space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">{m.auth_login_title()}</h1>
          <p className="text-muted-foreground text-sm">{m.auth_login_subtitle()}</p>
        </div>

        {error && <ErrorBanner title={m.auth_login_failed()} message={localizeAuthError(error)} />}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="identifier"
              className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
            >
              {m.auth_field_identifier()}
            </label>
            <div className="relative">
              <User className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
              <Input
                id="identifier"
                type="text"
                placeholder={m.auth_field_identifier_placeholder()}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="bg-background/50 h-10 pl-10"
                // The `webauthn` token must come last, and enables the
                // browser's conditional-UI passkey suggestion in this field.
                autoComplete="username webauthn"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="password"
                className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
              >
                {m.auth_field_password()}
              </label>
              <Link to="/forgot-password" className="text-link text-xs font-medium hover:underline">
                {m.auth_forgot_password_link()}
              </Link>
            </div>
            <div className="relative">
              <Lock className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-background/50 h-10 pl-10"
                autoComplete="current-password"
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
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                <span>{m.auth_signing_in()}</span>
              </>
            ) : (
              <>
                <LogIn className="h-4 w-4" />
                <span>{m.auth_log_in()}</span>
              </>
            )}
          </Button>
        </form>

        <SignInOptions />

        <div className="text-muted-foreground border-border/40 border-t pt-2 text-center text-xs">
          {m.auth_dont_have_account()}{" "}
          <Link
            to="/register"
            search={redirectFromSearch ? { redirect: redirectFromSearch } : {}}
            className="text-link font-medium hover:underline"
          >
            {m.auth_register_link()}
          </Link>
        </div>
      </PageCard>
    </div>
  );
}
