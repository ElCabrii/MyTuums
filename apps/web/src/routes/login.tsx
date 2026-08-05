import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
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
import { SignInOptions } from "@/components/sign-in-options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogIn, AlertCircle, Loader2, User, Lock } from "lucide-react";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  /**
   * Two search params, and together they prove the rule CLAUDE.md states:
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
   */
  validateSearch: (search: Record<string, unknown>): { error?: string; redirect?: string } => ({
    ...(typeof search.error === "string" ? { error: search.error } : {}),
    ...(typeof search.redirect === "string" ? { redirect: search.redirect } : {}),
  }),
});

/**
 * The sign-in page: identifier + password form, the OAuth/passkey options, and
 * the `?error=` banner that surfaces a failed OAuth round trip. `?redirect=`
 * carries the pre-login destination (see `validateSearch` above).
 */
function LoginPage() {
  const { redirect: redirectFromSearch } = Route.useSearch();
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
   */
  const { error: oauthError } = Route.useSearch();
  useEffect(() => {
    if (oauthError) setError(localizeOAuthError(oauthError));
  }, [oauthError, setError]);

  const handleSubmit = async (e: React.FormEvent) => {
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
      void navigate({
        to: "/two-factor",
        ...(redirectFromSearch ? { search: { redirect: redirectFromSearch } } : {}),
      });
    }
  };

  return (
    <div className="container max-w-md mx-auto px-4 py-12">
      <div className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">{m.auth_login_title()}</h1>
          <p className="text-sm text-muted-foreground">
            {m.auth_login_subtitle()}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-2xl bg-destructive/10 border border-destructive/20 p-4 text-sm text-destructive"
          >
            <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{m.auth_login_failed()}</p>
              <p className="text-destructive/90 text-xs mt-0.5">{localizeAuthError(error)}</p>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="identifier"
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {m.auth_field_identifier()}
            </label>
            <div className="relative">
              <User className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="identifier"
                type="text"
                placeholder={m.auth_field_identifier_placeholder()}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="pl-10 h-10 bg-background/50"
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
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {m.auth_field_password()}
              </label>
              <Link
                to="/forgot-password"
                className="text-xs font-medium text-link hover:underline"
              >
                {m.auth_forgot_password_link()}
              </Link>
            </div>
            <div className="relative">
              <Lock className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10 h-10 bg-background/50"
                autoComplete="current-password"
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

        <div className="text-center text-xs text-muted-foreground pt-2 border-t border-border/40">
          {m.auth_dont_have_account()}{" "}
          <Link
            to="/register"
            search={redirectFromSearch ? { redirect: redirectFromSearch } : {}}
            className="font-medium text-link hover:underline"
          >
            {m.auth_register_link()}
          </Link>
        </div>
      </div>
    </div>
  );
}
