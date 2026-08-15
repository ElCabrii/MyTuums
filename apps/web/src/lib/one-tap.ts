import { createAuthClient } from "better-auth/client";
import { oneTapClient } from "better-auth/client/plugins";
import type { BetterAuthClientPlugin } from "better-auth";
import { shouldOfferOneTap } from "@/lib/auth-client";
import { isReturningVisitor } from "@/lib/returning-visitor";
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
/**
 * The quarantined One Tap plugin's type: its own inferred surface intersected
 * with the plugin interface it does not *declare* itself compatible with
 * (narrower `$fetch` param — the upstream bug the module header documents).
 */
type OneTapPlugin = BetterAuthClientPlugin & ReturnType<typeof oneTapClient>;

const oneTapAuthClient = createAuthClient({
  plugins: [
    // SAFETY: at runtime the object conforms to BetterAuthClientPlugin; only the
    // declared $fetch narrowing keeps its own type from satisfying it directly.
    oneTapClient({
      clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "",
      // Google re-prompts on every dismissal by default, which turns "not
      // right now" into a prompt that reappears on each page. Two attempts is
      // enough to survive a mis-click without becoming an argument.
      promptOptions: { maxAttempts: 2 },
    }) as OneTapPlugin,
  ],
});

/** Module-scope so the guard survives re-renders and effect re-runs. */
let oneTapPrompted = false;

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

  // The session store can notify twice in quick succession when the first
  // `/get-session` lands, so `useOneTap`'s effect would otherwise call this
  // twice — two GSI prompts, two console errors, and Google's own "request
  // already in progress" warning. Once per document load is what the module
  // comment in `use-one-tap.ts` always claimed but never enforced.
  if (oneTapPrompted) return;

  // One Tap is a returning-user accelerator (and Google's abuse policy
  // discourages prompting first-time visitors). Skipping it for a brand-new
  // device also means the 90 KB GSI script never loads and its FedCM call
  // never logs "Not signed in with the identity provider" for them — the
  // `errors-in-console` audit failure. The flag is stamped the moment a
  // session first appears (`atoms/session.ts`); the Google button below
  // remains for everyone.
  if (!isReturningVisitor()) return;

  oneTapPrompted = true;

  // Same `?redirect=` param `signInWithProviderAtom` reads — One Tap's
  // success is a hard navigation to this URL, so the destination the signed-in
  // gate recorded survives a One Tap sign-in too.
  const redirect = sanitizeRedirect(new URLSearchParams(window.location.search).get("redirect"));

  void oneTapAuthClient.oneTap({ callbackURL: redirect ?? "/" }).catch((error) => {
    console.debug("Google One Tap unavailable:", error);
  });
}
