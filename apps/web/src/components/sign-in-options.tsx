import type { ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import { Fingerprint } from "lucide-react";
import { authPendingAtom, signInWithPasskeyAtom, signInWithProviderAtom } from "@/atoms/auth";
import { authClient, socialProviders, type SocialProviderId } from "@/lib/auth-client";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { GoogleIcon } from "@/components/icons/google-icon";
import { TwitchIcon } from "@/components/icons/twitch-icon";
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
  const navigate = useNavigate();
  const isBusy = useAtomValue(authPendingAtom);
  const signInWithProvider = useSetAtom(signInWithProviderAtom);
  const signInWithPasskey = useSetAtom(signInWithPasskeyAtom);

  /**
   * Rendered on both `/login` and `/register` (see the docblock below), so
   * unlike the OAuth path — whose `errorCallbackURL` always points at
   * `/login`, wherever the flow started — a banned passkey sign-in has to
   * navigate from right here rather than relying on `/login`'s own effect.
   */
  const handlePasskeySignIn = async () => {
    const outcome = await signInWithPasskey();
    if (outcome === "banned") {
      void navigate({ to: "/banned", replace: true });
    }
  };

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
  const supportsPasskeys = "PublicKeyCredential" in globalThis;

  if (socialProviders.length === 0 && !supportsPasskeys) return null;

  return (
    <div className="space-y-3">
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="border-border/40 w-full border-t" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-card text-muted-foreground px-3 text-xs tracking-wider uppercase">
            {m.auth_or_continue_with()}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        {socialProviders.map((provider) => (
          <ProviderButton
            key={provider.id}
            providerId={provider.id}
            label={provider.label}
            disabled={isBusy}
            lastUsed={lastUsed === provider.id}
            onClick={() => void signInWithProvider(provider.id)}
          />
        ))}

        {supportsPasskeys && (
          <NeutralButton disabled={isBusy} onClick={() => void handlePasskeySignIn()}>
            <Fingerprint className="text-muted-foreground h-4 w-4 shrink-0" />
            <span>{m.auth_continue_with_passkey()}</span>
            {lastUsed === "passkey" && <LastUsedBadge />}
          </NeutralButton>
        )}
      </div>
    </div>
  );
}

/**
 * Not `aria-label`ed as "last used" on the button itself: the text is already
 * in the accessible name via its content, so a label would replace the
 * provider name rather than add to it. One style now that every button in
 * this list shares the same neutral chrome — see `NeutralButton`.
 */
function LastUsedBadge() {
  return (
    <span className="bg-primary/10 text-primary dark:text-link rounded-full px-2 py-0.5 text-[10px] font-medium">
      {m.auth_last_used()}
    </span>
  );
}

/**
 * The shared chrome for every button in this list — Google's neutral
 * treatment (https://developers.google.com/identity/branding-guidelines),
 * reused for Discord, Twitch and the passkey option too, rather than one
 * button per row in a different brand color.
 *
 * Google's spec is the only one of the three that mandates a button design at
 * all: exact colors, a non-recolorable logo, and light/dark variants. Discord
 * and Twitch's guidelines cover the *mark* only ("do not edit, distort,
 * recolor, or reconfigure" it outside the variants they publish) — they don't
 * prescribe a button background, so nothing here is out of policy by not
 * using their brand color as a fill. A row of Google-grey/Discord-blurple/
 * Twitch-purple buttons also reads like three unrelated products bolted
 * together rather than one sign-in list; matching Google's chrome and letting
 * each icon carry its own brand color is the calmer result, and is exactly
 * the "colored icon on a neutral surface" pattern most production apps use.
 */
function NeutralButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-10 w-full items-center justify-center gap-2.5 rounded-2xl border border-[#747775] bg-white pr-3 pl-3 text-sm font-medium text-[#1F1F1F] hover:bg-[#F8F9FA] disabled:pointer-events-none disabled:opacity-60 dark:border-[#8E918F] dark:bg-[#131314] dark:text-[#E3E3E3] dark:hover:bg-[#1E1F20]"
    >
      {children}
    </button>
  );
}

/**
 * The icon each provider owns, at a fixed brand color regardless of theme.
 *
 * Google's "G" is excluded — its guidelines forbid changing its color, so it
 * keeps its own hardcoded multi-color paths (`GoogleIcon`) rather than going
 * through `currentColor` here. Discord's Blurple and Twitch's Purple are both
 * saturated enough to read clearly against both the white and near-black
 * neutral surfaces `NeutralButton` uses, which is why one fixed shade works
 * for both themes instead of swapping to a lighter variant in dark mode.
 */
function ProviderIcon({ providerId }: { providerId: SocialProviderId }) {
  if (providerId === "google") return <GoogleIcon className="h-5 w-5 shrink-0" />;
  if (providerId === "discord") {
    return <DiscordIcon className="h-4 w-4 shrink-0" style={{ color: "#5865F2" }} />;
  }
  return <TwitchIcon className="h-4 w-4 shrink-0" style={{ color: "#9146FF" }} />;
}

function ProviderButton({
  providerId,
  label,
  disabled,
  lastUsed,
  onClick,
}: {
  providerId: SocialProviderId;
  label: string;
  disabled: boolean;
  lastUsed: boolean;
  onClick: () => void;
}) {
  return (
    <NeutralButton disabled={disabled} onClick={onClick}>
      <ProviderIcon providerId={providerId} />
      <span>{m.auth_continue_with({ provider: label })}</span>
      {lastUsed && <LastUsedBadge />}
    </NeutralButton>
  );
}
