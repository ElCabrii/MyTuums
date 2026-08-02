import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import {
  claimHandleAtom,
  handleDraftAtom,
  handleValidationAtom,
  resetHandleClaimAtom,
} from "@/atoms/handle-claim";
import { isSignedInAtom, sessionPendingAtom } from "@/atoms/session";
import { useRedirectWhenSignedIn } from "@/hooks/use-redirect-when-signed-in";
import { localizeAuthError } from "@/lib/auth-error-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle, AtSign, Check, Loader2 } from "lucide-react";
import { m } from "@/paraglide/messages.js";

export const Route = createFileRoute("/welcome")({
  component: WelcomePage,
});

/**
 * Where a social sign-up finishes becoming an account.
 *
 * OAuth gives us a name, an email and an avatar but no handle — and this app's
 * profile URLs, follow lists and `user.byUsername` lookups are all keyed on
 * one. `useRequireHandle` (mounted in `__root.tsx`) sends any handle-less
 * session here and keeps it here; this is the page that lets it leave.
 */
function WelcomePage() {
  const navigate = useNavigate();
  const isSignedIn = useAtomValue(isSignedInAtom);
  const isSessionPending = useAtomValue(sessionPendingAtom);

  /**
   * This is the whole exit from this page, and it is reused rather than
   * reimplemented on purpose.
   *
   * `useRedirectWhenSignedIn` sends a session that *has* a handle to its
   * profile, and one that doesn't to `/welcome` — a no-op while we're already
   * here. So it covers both reasons to leave with one rule: arriving with a
   * handle already (a bookmark, a back button), and claiming one just now.
   *
   * The first version of this page navigated from the submit handler *and*
   * ran a separate `!needsHandle → "/"` guard. Both fired the instant the
   * claim landed and the guard won, dropping people on the home feed instead
   * of their new profile. That is the same double-navigation race
   * `register.tsx` had, and the fix is the same one: exactly one effect owns
   * the redirect, and actions only change the session.
   */
  useRedirectWhenSignedIn();

  /**
   * The one case the hook above can't cover — it only acts on sessions that
   * exist. Someone signed out who types this URL has nothing to claim.
   *
   * `isSessionPending` first, and that matters: `isSignedInAtom` reads false
   * while BetterAuth's first `/get-session` is still in flight, so on a cold
   * load this would fire against a session that simply hasn't arrived yet and
   * eject a signed-in person to `/login`.
   */
  useEffect(() => {
    if (isSessionPending) return;
    if (!isSignedIn) void navigate({ to: "/login", replace: true });
  }, [isSessionPending, isSignedIn, navigate]);

  const [handle, setHandle] = useAtom(handleDraftAtom);
  const validationError = useAtomValue(handleValidationAtom);
  const [error, setError] = useAtom(authErrorAtom);
  const isSubmitting = useAtomValue(authPendingAtom);
  const claimHandle = useSetAtom(claimHandleAtom);

  // Same lifetime rule as the auth forms (see atoms/auth-form.ts): reset on
  // unmount rather than scoping with a nested Provider, which would give this
  // subtree its own empty store and break the session reads above.
  const resetForm = useSetAtom(resetHandleClaimAtom);
  useEffect(() => resetForm, [resetForm]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (validationError) {
      setError(validationError);
      return;
    }

    // Deliberately does not navigate — see `useRedirectWhenSignedIn` above.
    await claimHandle();
  };

  return (
    <div className="container max-w-md mx-auto px-4 py-12">
      <div className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">{m.welcome_title()}</h1>
          <p className="text-sm text-muted-foreground">{m.welcome_subtitle()}</p>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-2xl bg-destructive/10 border border-destructive/20 p-4 text-sm text-destructive"
          >
            <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{m.welcome_claim_failed()}</p>
              <p className="text-destructive/90 text-xs mt-0.5">{localizeAuthError(error)}</p>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="handle"
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {m.auth_field_username()}
            </label>
            <div className="relative">
              <AtSign className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="handle"
                type="text"
                placeholder={m.auth_field_username_placeholder()}
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                className="pl-10 h-10 bg-background/50"
                autoComplete="username"
                autoFocus
                required
              />
            </div>
            <p className="text-xs text-muted-foreground">{m.welcome_handle_hint()}</p>
          </div>

          <Button
            type="submit"
            className="w-full h-11 text-base font-medium rounded-2xl gap-2 mt-2"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{m.welcome_claiming()}</span>
              </>
            ) : (
              <>
                <Check className="h-4 w-4" />
                <span>{m.welcome_claim()}</span>
              </>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
