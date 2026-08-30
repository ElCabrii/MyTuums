import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { installTestAuthClient } from "@/lib/auth-client";

type AuthClientResult = { data: unknown; error: unknown };

const { linkSocial, unlinkAccount } = vi.hoisted(() => ({
  linkSocial: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
  unlinkAccount: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
}));

// SAFETY: the recording fakes resolve the { data, error } shapes the app reads
// from the real client; the seam swaps only what each suite needs.
installTestAuthClient({
  authClient: { linkSocial, unlinkAccount },
});

import { authErrorAtom } from "@/atoms/auth";
import {
  linkProviderAtom,
  linkedAccountsQueryKey,
  unlinkProviderAtom,
} from "@/atoms/linked-accounts";

function freshStore() {
  const store = createStore();
  const queryClient = new QueryClient();
  // Seed the cached list so the invalidation has a query to mark — a query
  // that was never observed has no state for `invalidateQueries` to touch.
  queryClient.setQueryData(linkedAccountsQueryKey, []);
  store.set(queryClientAtom, queryClient);
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("linkProviderAtom", () => {
  it("hands off with an absolute callback so the redirect lands on the web app, not the API", async () => {
    const store = freshStore();

    await store.set(linkProviderAtom, "google");

    expect(linkSocial).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: `${window.location.origin}/settings/account`,
    });
  });

  it("surfaces a failure in the shared error atom", async () => {
    const store = freshStore();
    linkSocial.mockResolvedValueOnce({ data: null, error: { message: "Already linked" } });

    await store.set(linkProviderAtom, "google");

    expect(store.get(authErrorAtom)).toBe("Already linked");
  });
});

describe("unlinkProviderAtom", () => {
  it("unlinks the exact account and invalidates the cached list on success", async () => {
    const store = freshStore();

    const ok = await store.set(unlinkProviderAtom, {
      providerId: "google",
      accountId: "google-1",
    });

    expect(ok).toBe(true);
    expect(unlinkAccount).toHaveBeenCalledWith({ providerId: "google", accountId: "google-1" });
    expect(store.get(queryClientAtom).getQueryState(linkedAccountsQueryKey)?.isInvalidated).toBe(
      true,
    );
  });

  it("surfaces a failure in the shared error atom", async () => {
    const store = freshStore();
    unlinkAccount.mockResolvedValueOnce({
      data: null,
      error: { message: "FAILED_TO_UNLINK_LAST_ACCOUNT" },
    });

    const ok = await store.set(unlinkProviderAtom, {
      providerId: "credential",
      accountId: "credential-1",
    });

    expect(ok).toBe(false);
    expect(store.get(authErrorAtom)).toBe("FAILED_TO_UNLINK_LAST_ACCOUNT");
  });
});
