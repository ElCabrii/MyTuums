import { atom } from "jotai";
import { atomWithReset, RESET } from "jotai/utils";
import { atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import type { QueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { authErrorAtom, authPendingAtom, errorCodeOf } from "@/atoms/auth";
import { m } from "@/paraglide/messages.js";

/**
 * The signed-in user's passkeys.
 *
 * A TanStack query rather than a plain atom so the settings page gets caching,
 * a loading state and one shared observer for free — the same reasons
 * `atoms/profile.ts` uses `atomWithQuery` — even though this reads from
 * BetterAuth's client instead of oRPC.
 *
 * The key carries no user id, and does not need to: `signOutAtom` clears the
 * whole QueryClient, so one person's passkeys can never be served to the next
 * person on this browser.
 */
/** The query key the passkeys query is cached under — shared so invalidations always target it. */
export const passkeysQueryKey = ["passkeys"] as const;

/** The signed-in user's passkeys, from a cached query. */
export const passkeysAtom = atomWithQuery(() => ({
  queryKey: passkeysQueryKey,
  queryFn: async () => {
    const res = await authClient.passkey.listUserPasskeys();
    if (res.error) throw new Error(res.error.message ?? "Failed to load passkeys");
    return res.data;
  },
  // Enrolling a passkey elsewhere is rare enough that background refetching
  // on every window focus would be pure noise; the mutations below invalidate
  // explicitly instead.
  staleTime: 60_000,
}));

/**
 * Which passkey is being renamed, and what to.
 *
 * The id lives in one atom rather than a boolean per row for the same reason
 * `followListDialogAtom` holds the open dialog's identity: holding *which* row
 * is open makes "only one at a time" structural, where a flag per row makes it
 * something every row has to remember to enforce against every other.
 */
/** Which passkey is being renamed — null when no row is open. */
export const editingPasskeyIdAtom = atom<string | null>(null);
/** The rename draft, seeded from the passkey being renamed. */
export const passkeyNameDraftAtom = atomWithReset("");

/** Name for a passkey about to be registered. Optional — the authenticator supplies a default. */
export const newPasskeyNameAtom = atomWithReset("");

/** Opens the rename row for a passkey (or closes it with null), seeding the draft. */
export const startRenamingPasskeyAtom = atom(
  null,
  (_get, set, passkey: { id: string; name?: string | null } | null) => {
    set(editingPasskeyIdAtom, passkey?.id ?? null);
    set(passkeyNameDraftAtom, passkey?.name ?? "");
  },
);

/** Clears every passkey form field and the open row — unmount cleanup. */
export const resetPasskeyFormsAtom = atom(null, (_get, set) => {
  set(editingPasskeyIdAtom, null);
  set(passkeyNameDraftAtom, RESET);
  set(newPasskeyNameAtom, RESET);
});

/** Re-reads the list after a mutation, so the UI never shows a stale set. */
function invalidatePasskeys(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: passkeysQueryKey });
}

/**
 * Registers a new passkey.
 *
 * A cancelled WebAuthn prompt is not surfaced as an error: dismissing the
 * browser's sheet is a normal way to change your mind, and an alert saying
 * "Registration cancelled" reads as a malfunction. Note the passkey plugin
 * resolves rather than rejects on failure, so `res.error` is the only signal.
 */
export const addPasskeyAtom = atom(null, async (get, set, name?: string): Promise<boolean> => {
  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const trimmed = name?.trim();
    const res = await authClient.passkey.addPasskey(trimmed ? { name: trimmed } : {});

    if (res?.error) {
      if (errorCodeOf(res.error) !== "REGISTRATION_CANCELLED") {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      }
      return false;
    }

    await invalidatePasskeys(get(queryClientAtom));
    return true;
  } catch (err) {
    console.error("Passkey registration error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});

/** Renames a passkey and re-reads the list; returns whether it succeeded. */
export const renamePasskeyAtom = atom(
  null,
  async (get, set, { id, name }: { id: string; name: string }): Promise<boolean> => {
    const trimmed = name.trim();
    if (!trimmed) return false;

    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      const res = await authClient.passkey.updatePasskey({ id, name: trimmed });
      if (res.error) {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return false;
      }
      await invalidatePasskeys(get(queryClientAtom));
      return true;
    } catch (err) {
      console.error("Passkey rename error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
      return false;
    } finally {
      set(authPendingAtom, false);
    }
  },
);

/** Deletes a passkey and re-reads the list; returns whether it succeeded. */
export const deletePasskeyAtom = atom(null, async (get, set, id: string): Promise<boolean> => {
  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const res = await authClient.passkey.deletePasskey({ id });
    if (res.error) {
      set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      return false;
    }
    await invalidatePasskeys(get(queryClientAtom));
    return true;
  } catch (err) {
    console.error("Passkey delete error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});
