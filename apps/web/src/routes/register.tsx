import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, type FormEvent } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { authErrorAtom, authPendingAtom, signUpAtom } from "@/atoms/auth";
import {
  registerConfirmPasswordAtom,
  registerDateOfBirthAtom,
  registerEmailAtom,
  registerNameAtom,
  registerPasswordAtom,
  registerUsernameAtom,
  registerValidationAtom,
  resetRegisterFormAtom,
} from "@/atoms/auth-form";
import { useRedirectWhenSignedIn } from "@/hooks/use-redirect-when-signed-in";
import { localizeAuthError } from "@/lib/auth-error-message";
import { ErrorBanner } from "@/components/error-banner";
import { PageCard } from "@/components/page-card";
import { SignInOptions } from "@/components/sign-in-options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserPlus, Loader2, User, Mail, Lock, AtSign, Calendar } from "lucide-react";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/register")({
  component: RegisterPage,
  /**
   * The `redirect` param is the one the signed-in gate set on `/login`
   * (`use-require-signed-in.ts`) and that the "Register here" link carried
   * here — see login.tsx for the rationale. Narrowed to a string: it arrives
   * in the URL, and it is sanitized again in `lib/redirect.ts` before any
   * navigation honours it.
   */
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
});

/**
 * The sign-up page: username, display name, email, password and date of birth,
 * plus the same OAuth/passkey options as `/login`. Success flows through the
 * session updating — navigation is owned by `useRedirectWhenSignedIn` (see the
 * double-navigation note in the submit handler).
 */
function RegisterPage() {
  const { redirect: redirectFromSearch } = Route.useSearch();
  useRedirectWhenSignedIn(redirectFromSearch);

  const [username, setUsername] = useAtom(registerUsernameAtom);
  const [name, setName] = useAtom(registerNameAtom);
  const [email, setEmail] = useAtom(registerEmailAtom);
  const [password, setPassword] = useAtom(registerPasswordAtom);
  const [confirmPassword, setConfirmPassword] = useAtom(registerConfirmPasswordAtom);
  const [dateOfBirth, setDateOfBirth] = useAtom(registerDateOfBirthAtom);
  const validationError = useAtomValue(registerValidationAtom);
  const [error, setError] = useAtom(authErrorAtom);
  const isSubmitting = useAtomValue(authPendingAtom);
  const signUp = useSetAtom(signUpAtom);

  // See auth-form.ts: resetting on unmount is what bounds these atoms'
  // lifetime to this page instead of a nested Provider (which would break
  // useRedirectWhenSignedIn's session read above).
  const resetForm = useSetAtom(resetRegisterFormAtom);
  useEffect(() => resetForm, [resetForm]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (validationError) {
      setError(validationError);
      return;
    }

    // No navigate here — success flows through the session updating, which
    // useRedirectWhenSignedIn picks up. Calling it here too was the old
    // double-navigation bug.
    await signUp({ username, name, email, password, dateOfBirth });
  };

  return (
    <div className="container mx-auto max-w-lg px-4 py-12">
      <PageCard className="space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">{m.auth_register_title()}</h1>
          <p className="text-muted-foreground text-sm">{m.auth_register_subtitle()}</p>
        </div>

        {error && (
          <ErrorBanner title={m.auth_register_failed()} message={localizeAuthError(error)} />
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="username"
                className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
              >
                {m.auth_field_username()}
              </label>
              <div className="relative">
                <AtSign className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
                <Input
                  id="username"
                  type="text"
                  placeholder={m.auth_field_username_placeholder()}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="bg-background/50 h-10 pl-10"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="name"
                className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
              >
                {m.auth_field_display_name()}
              </label>
              <div className="relative">
                <User className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
                <Input
                  id="name"
                  type="text"
                  placeholder={m.auth_field_display_name_placeholder()}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="bg-background/50 h-10 pl-10"
                  autoComplete="name"
                  required
                />
              </div>
            </div>
          </div>

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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="password"
                className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
              >
                {m.auth_field_password()}
              </label>
              <div className="relative">
                <Lock className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
                <Input
                  id="password"
                  type="password"
                  placeholder=""
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-background/50 h-10 pl-10"
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="confirmPassword"
                className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
              >
                {m.auth_field_confirm_password()}
              </label>
              <div className="relative">
                <Lock className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder=""
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="bg-background/50 h-10 pl-10"
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="dateOfBirth"
              className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
            >
              {m.auth_field_date_of_birth()}
            </label>
            <div className="relative">
              <Calendar className="text-muted-foreground absolute top-3 left-3.5 h-4 w-4" />
              <Input
                id="dateOfBirth"
                type="date"
                value={dateOfBirth}
                onChange={(e) => setDateOfBirth(e.target.value)}
                className="bg-background/50 h-10 pl-10"
                autoComplete="bday"
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
                <span>{m.auth_creating_account()}</span>
              </>
            ) : (
              <>
                <UserPlus className="h-4 w-4" />
                <span>{m.auth_register()}</span>
              </>
            )}
          </Button>
        </form>

        <SignInOptions />

        <div className="text-muted-foreground border-border/40 border-t pt-2 text-center text-xs">
          {m.auth_already_have_account()}{" "}
          <Link
            to="/login"
            search={redirectFromSearch ? { redirect: redirectFromSearch } : {}}
            className="text-link font-medium hover:underline"
          >
            {m.auth_login_link()}
          </Link>
        </div>
      </PageCard>
    </div>
  );
}
