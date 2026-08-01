import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { authClient } from "@/lib/auth-client";
import { isSignedInAtom, viewerHandleAtom } from "@/atoms/session";
import { handleOf } from "@/lib/user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogIn, AlertCircle, Loader2, User, Lock } from "lucide-react";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sending someone to their own profile needs their handle, and the handle
  // only exists once we have a user — so both redirects below fall back to
  // the home feed rather than building a `/@undefined` URL.
  const goToProfile = (handle: string | null) => {
    if (handle) {
      void navigate({ to: "/@{$username}", params: { username: handle } });
    } else {
      void navigate({ to: "/" });
    }
  };

  // Someone who already has a session has no business on the login form, so
  // bounce them to their profile. This has to run in an effect rather than
  // during render: `navigate()` updates the router's Transitioner, and doing
  // that while this component is still rendering is exactly the "Cannot
  // update a component while rendering a different component" warning React
  // emits. Depending on primitives (not the session object, whose identity
  // can change between renders) keeps the effect from re-firing on every
  // render while the redirect is in flight.
  //
  // `replace` rather than push: without it, back-navigating to /login just
  // redirects forward again and the back button is dead.
  const isAuthenticated = useAtomValue(isSignedInAtom);
  const sessionHandle = useAtomValue(viewerHandleAtom);

  useEffect(() => {
    if (!isAuthenticated) return;

    if (sessionHandle) {
      void navigate({
        to: "/@{$username}",
        params: { username: sessionHandle },
        replace: true,
      });
    } else {
      void navigate({ to: "/", replace: true });
    }
  }, [isAuthenticated, sessionHandle, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!identifier.trim()) {
      setError("Please enter your username or email address.");
      return;
    }
    if (!password) {
      setError("Please enter your password.");
      return;
    }

    setIsSubmitting(true);

    try {
      const isEmail = identifier.includes("@");
      
      const res = isEmail
        ? await authClient.signIn.email({
            email: identifier.trim(),
            password,
          })
        : await authClient.signIn.username({
            username: identifier.trim(),
            password,
          });

      if (res.error) {
        setError(res.error.message || "Invalid credentials. Please try again.");
      } else {
        goToProfile(handleOf(res.data?.user) ?? (isEmail ? null : identifier.trim()));
      }
    } catch (err: unknown) {
      console.error("Login error:", err);
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="container max-w-md mx-auto px-4 py-12">
      <div className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Welcome Back</h1>
          <p className="text-sm text-muted-foreground">
            Log in to your MyTuums account using your username or email
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-2xl bg-destructive/10 border border-destructive/20 p-4 text-sm text-destructive"
          >
            <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Sign in failed</p>
              <p className="text-destructive/90 text-xs mt-0.5">{error}</p>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="identifier"
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Username or Email
            </label>
            <div className="relative">
              <User className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="identifier"
                type="text"
                placeholder="john_doe or john@example.com"
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
                Password
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
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <LogIn className="h-4 w-4" />
                <span>Log In</span>
              </>
            )}
          </Button>
        </form>

        <div className="text-center text-xs text-muted-foreground pt-2 border-t border-border/40">
          Don't have an account?{" "}
          <Link
            to="/register"
            className="font-medium text-primary hover:underline"
          >
            Register here
          </Link>
        </div>
      </div>
    </div>
  );
}
