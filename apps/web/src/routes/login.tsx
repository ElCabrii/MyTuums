import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { authErrorAtom, authPendingAtom, signInAtom } from "@/atoms/auth";
import {
  loginIdentifierAtom,
  loginPasswordAtom,
  loginValidationAtom,
  resetLoginFormAtom,
} from "@/atoms/auth-form";
import { useRedirectWhenSignedIn } from "@/hooks/use-redirect-when-signed-in";
import { localizeAuthError } from "@/lib/auth-error-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogIn, AlertCircle, Loader2, User, Lock } from "lucide-react";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  useRedirectWhenSignedIn();

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (validationError) {
      setError(validationError);
      return;
    }

    await signIn({ identifier, password });
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
                autoComplete="username"
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
                <Loader2 className="h-4 w-4 animate-spin" />
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

        <div className="text-center text-xs text-muted-foreground pt-2 border-t border-border/40">
          {m.auth_dont_have_account()}{" "}
          <Link
            to="/register"
            className="font-medium text-primary hover:underline"
          >
            {m.auth_register_link()}
          </Link>
        </div>
      </div>
    </div>
  );
}
