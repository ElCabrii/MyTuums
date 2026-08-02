import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { authErrorAtom, authPendingAtom, signUpAtom } from "@/atoms/auth";
import {
  registerConfirmPasswordAtom,
  registerEmailAtom,
  registerNameAtom,
  registerPasswordAtom,
  registerUsernameAtom,
  registerValidationAtom,
  resetRegisterFormAtom,
} from "@/atoms/auth-form";
import { useRedirectWhenSignedIn } from "@/hooks/use-redirect-when-signed-in";
import { localizeAuthError } from "@/lib/auth-error-message";
import { SignInOptions } from "@/components/sign-in-options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserPlus, AlertCircle, Loader2, User, Mail, Lock, AtSign } from "lucide-react";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/register")({
  component: RegisterPage,
});

function RegisterPage() {
  useRedirectWhenSignedIn();

  const [username, setUsername] = useAtom(registerUsernameAtom);
  const [name, setName] = useAtom(registerNameAtom);
  const [email, setEmail] = useAtom(registerEmailAtom);
  const [password, setPassword] = useAtom(registerPasswordAtom);
  const [confirmPassword, setConfirmPassword] = useAtom(registerConfirmPasswordAtom);
  const validationError = useAtomValue(registerValidationAtom);
  const [error, setError] = useAtom(authErrorAtom);
  const isSubmitting = useAtomValue(authPendingAtom);
  const signUp = useSetAtom(signUpAtom);

  // See auth-form.ts: resetting on unmount is what bounds these atoms'
  // lifetime to this page instead of a nested Provider (which would break
  // useRedirectWhenSignedIn's session read above).
  const resetForm = useSetAtom(resetRegisterFormAtom);
  useEffect(() => resetForm, [resetForm]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (validationError) {
      setError(validationError);
      return;
    }

    // No navigate here — success flows through the session updating, which
    // useRedirectWhenSignedIn picks up. Calling it here too was the old
    // double-navigation bug.
    await signUp({ username, name, email, password });
  };

  return (
    <div className="container max-w-lg mx-auto px-4 py-12">
      <div className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">{m.auth_register_title()}</h1>
          <p className="text-sm text-muted-foreground">
            {m.auth_register_subtitle()}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-2xl bg-destructive/10 border border-destructive/20 p-4 text-sm text-destructive"
          >
            <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{m.auth_register_failed()}</p>
              <p className="text-destructive/90 text-xs mt-0.5">{localizeAuthError(error)}</p>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label
                htmlFor="username"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {m.auth_field_username()}
              </label>
              <div className="relative">
                <AtSign className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="username"
                  type="text"
                  placeholder={m.auth_field_username_placeholder()}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="pl-10 h-10 bg-background/50"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="name"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {m.auth_field_display_name()}
              </label>
              <div className="relative">
                <User className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="name"
                  type="text"
                  placeholder={m.auth_field_display_name_placeholder()}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="pl-10 h-10 bg-background/50"
                  autoComplete="name"
                  required
                />
              </div>
            </div>
          </div>

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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label
                htmlFor="password"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {m.auth_field_password()}
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  placeholder=""
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 h-10 bg-background/50"
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="confirmPassword"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {m.auth_field_confirm_password()}
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder=""
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="pl-10 h-10 bg-background/50"
                  autoComplete="new-password"
                  required
                />
              </div>
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

        <div className="text-center text-xs text-muted-foreground pt-2 border-t border-border/40">
          {m.auth_already_have_account()}{" "}
          <Link
            to="/login"
            className="font-medium text-primary hover:underline"
          >
            {m.auth_login_link()}
          </Link>
        </div>
      </div>
    </div>
  );
}
