import { createAuthClient } from "better-auth/client";
import { oneTapClient } from "better-auth/client/plugins";
import type { BetterAuthClientPlugin } from "better-auth";
import { shouldOfferOneTap } from "@/lib/auth-client";
import { sanitizeRedirect } from "@/lib/redirect";

/**
 * Google One Tap, quarantined into its own auth client.
 *
 * ## Why it isn't on the main client
 *
 * `oneTapClient`'s `getActions` declares a narrower `$fetch` parameter than
 * `BetterAuthClientPlugin` requires, so the plugin does not satisfy the
 * interface in better-auth 1.6.25 — an upstream typing bug, not a
 * misconfiguration here. Because Better Auth infers a client's entire surface
 * from its plugin array's element type, including it (or casting it in place)
 * widened that union and erased `signIn.email`, `passkey.*`, `twoFactor.*` and
 * `session.user.username` from `authClient` all at once.
 *
 * A second client keeps the blast radius to this file: exactly one cast, and
 * `lib/auth-client.ts` stays fully inferred. Delete this module and move the
 * plugin back once the upstream signature is fixed.
 *
 * ## Why a second client is safe here
 *
 * Both clients talk to the same origin and therefore the same session cookie,
 * and this one's session store is never subscribed to — so it issues no
 * `/get-session` of its own. One Tap's success path is a hard navigation to
 * `callbackURL`, which reloads the document and lets the main client read the
 * new session the ordinary way. Nothing has to be synchronised between them.
 */
const oneTapAuthClient = createAuthClient({
  plugins: [
    oneTapClient({
      clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "",
      // Google re-prompts on every dismissal by default, which turns "not
      // right now" into a prompt that reappears on each page. Two attempts is
      // enough to survive a mis-click without becoming an argument.
      promptOptions: { maxAttempts: 2 },
    }) as unknown as BetterAuthClientPlugin,
  ],
});

/** The one action we use, named explicitly because the cast above erased it. */
interface OneTapCapableClient {
  oneTap: (options?: { callbackURL?: string }) => Promise<unknown>;
}

/**
 * Shows the One Tap prompt, if this deployment configured Google.
 *
 * Deliberately fire-and-forget and deliberately silent on failure: One Tap is
 * an accelerator sitting above a sign-in form that already works. A blocked
 * prompt, a third-party-cookie restriction or a dismissal should leave the
 * page exactly as it was, not raise an error about a thing the person never
 * asked for.
 */
export function promptOneTap(): void {
  if (!shouldOfferOneTap) return;

  // Same `?redirect=` param `signInWithProviderAtom` reads — One Tap's
  // success is a hard navigation to this URL, so the destination the signed-in
  // gate recorded survives a One Tap sign-in too.
  const redirect = sanitizeRedirect(
    new URLSearchParams(window.location.search).get("redirect"),
  );

  void (oneTapAuthClient as unknown as OneTapCapableClient)
    .oneTap({ callbackURL: redirect ?? "/" })
    .catch((error: unknown) => {
      console.debug("Google One Tap unavailable:", error);
    });
}
