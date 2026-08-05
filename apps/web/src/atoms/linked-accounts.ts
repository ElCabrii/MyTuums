import { atom } from "jotai";
import { atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import type { QueryClient } from "@tanstack/react-query";
import { authClient, type SocialProviderId } from "@/lib/auth-client";
import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import { m } from "@/paraglide/messages.js";

/**
 * The providers this account can sign in with.
 *
 * `credential` appears in this list too — it is how BetterAuth represents an
 * email/password login — which is what makes "can I unlink this?" answerable
 * on the client: an account with exactly one entry must keep it, or the person
 * locks themselves out. The server enforces the same rule
 * (`FAILED_TO_UNLINK_LAST_ACCOUNT`); this is so the button is disabled rather
 * than the error arriving after the click.
 */
/** The query key the linked-accounts query is cached under — shared so invalidations always target it. */
export const linkedAccountsQueryKey = ["linked-accounts"] as const;

/** The signed-in account's linked providers, from a cached query. */
export const linkedAccountsAtom = atomWithQuery(() => ({
  queryKey: linkedAccountsQueryKey,
  queryFn: async () => {
    const res = await authClient.listAccounts();
    if (res.error) throw new Error(res.error.message ?? "Failed to load linked accounts");
    return res.data;
  },
  staleTime: 60_000,
}));

function invalidateLinkedAccounts(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: linkedAccountsQueryKey });
}

/**
 * Sends the browser off to link another provider. Resolves only on failure —
 * a successful handoff navigates away.
 *
 * This is also the only route onto the account for a provider excluded from
 * `trustedProviders` server-side (Twitch — see packages/auth/src/social.ts):
 * automatic linking on an email match is refused for those, so the person
 * links deliberately from here instead.
 */
export const linkProviderAtom = atom(
  null,
  async (_get, set, provider: SocialProviderId): Promise<void> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      // Absolute for the same reason as `signInWithProviderAtom` — BetterAuth
      // redirects to this verbatim from its own origin, so a relative path
      // lands on the API server rather than the web app whenever the two are
      // not same-origin (which they are not in dev).
      const res = await authClient.linkSocial({
        provider,
        callbackURL: `${window.location.origin}/settings/account`,
      });
      if (res.error) {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      }
    } catch (err) {
      console.error("Account link error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
    } finally {
      set(authPendingAtom, false);
    }
  },
);

/**
 * Unlinks a provider from this account and refreshes the list; returns whether
 * it succeeded. The server refuses to unlink the last account — this surfaces
 * that error for the banner rather than letting the click go through.
 */
export const unlinkProviderAtom = atom(
  null,
  async (
    get,
    set,
    { providerId, accountId }: { providerId: string; accountId: string },
  ): Promise<boolean> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      const res = await authClient.unlinkAccount({ providerId, accountId });
      if (res.error) {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return false;
      }
      await invalidateLinkedAccounts(get(queryClientAtom));
      return true;
    } catch (err) {
      console.error("Account unlink error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
      return false;
    } finally {
      set(authPendingAtom, false);
    }
  },
);
