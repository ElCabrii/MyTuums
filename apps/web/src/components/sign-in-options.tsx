import { useAtomValue, useSetAtom } from "jotai";
import { Fingerprint } from "lucide-react";
import { authPendingAtom, signInWithPasskeyAtom, signInWithProviderAtom } from "@/atoms/auth";
import { authClient, socialProviders } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";

/**
 * The passwordless half of the sign-in forms: OAuth providers and passkeys,
 * with a "last used" marker on whichever the person reached for last time.
 *
 * Shared by `/login` and `/register` because the choice is the same on both —
 * signing in and signing up with a provider are one flow, and offering it in
 * only one place would make the other look like it did not support it.
 *
 * Renders nothing at all when this deployment has no providers configured and
 * the browser has no passkey support: an empty "or continue with" divider over
 * a blank row is worse than no divider.
 */
export function SignInOptions() {
  const isBusy = useAtomValue(authPendingAtom);
  const signInWithProvider = useSetAtom(signInWithProviderAtom);
  const signInWithPasskey = useSetAtom(signInWithPasskeyAtom);

  /**
   * Read straight from the plugin rather than held in an atom.
   *
   * It is a synchronous cookie read, not subscribed state — the value only
   * changes as a *result* of leaving this page, so an atom would add a cache
   * that has to be invalidated and could go stale after a sign-out without
   * buying anything.
   */
  const lastUsed = authClient.getLastUsedLoginMethod();

  // WebAuthn is absent on older browsers and in some embedded webviews;
  // offering a button that can only fail is worse than not offering it.
  const supportsPasskeys = typeof window !== "undefined" && "PublicKeyCredential" in window;

  if (socialProviders.length === 0 && !supportsPasskeys) return null;

  return (
    <div className="space-y-3">
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-border/40" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-card px-3 text-xs uppercase tracking-wider text-muted-foreground">
            {m.auth_or_continue_with()}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        {socialProviders.map((provider) => (
          <Button
            key={provider.id}
            type="button"
            variant="outline"
            className="w-full h-10 rounded-2xl justify-center gap-2"
            disabled={isBusy}
            onClick={() => void signInWithProvider(provider.id)}
          >
            <span>{m.auth_continue_with({ provider: provider.label })}</span>
            {lastUsed === provider.id && <LastUsedBadge />}
          </Button>
        ))}

        {supportsPasskeys && (
          <Button
            type="button"
            variant="outline"
            className="w-full h-10 rounded-2xl justify-center gap-2"
            disabled={isBusy}
            onClick={() => void signInWithPasskey()}
          >
            <Fingerprint className="h-4 w-4" />
            <span>{m.auth_continue_with_passkey()}</span>
            {lastUsed === "passkey" && <LastUsedBadge />}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Not `aria-label`ed as "last used" on the button itself: the text is already
 * in the accessible name via its content, so a label would replace the
 * provider name rather than add to it.
 */
function LastUsedBadge() {
  return (
    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
      {m.auth_last_used()}
    </span>
  );
}
