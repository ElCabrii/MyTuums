import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";

type AuthClientResult = { data: unknown; error: unknown };

const { addPasskey, updatePasskey, deletePasskey } = vi.hoisted(() => ({
  addPasskey: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
  updatePasskey: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
  deletePasskey: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    passkey: { addPasskey, updatePasskey, deletePasskey },
  },
}));

import { authErrorAtom } from "@/atoms/auth";
import {
  addPasskeyAtom,
  deletePasskeyAtom,
  passkeysQueryKey,
  renamePasskeyAtom,
} from "@/atoms/passkey";

function freshStore() {
  const store = createStore();
  const queryClient = new QueryClient();
  // Seed the cached list so the invalidation has a query to mark — a query
  // that was never observed has no state for `invalidateQueries` to touch.
  queryClient.setQueryData(passkeysQueryKey, []);
  store.set(queryClientAtom, queryClient);
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addPasskeyAtom", () => {
  it("trims the name and invalidates the cached list on success", async () => {
    const store = freshStore();

    const ok = await store.set(addPasskeyAtom, "  Desk key  ");

    expect(ok).toBe(true);
    expect(addPasskey).toHaveBeenCalledWith({ name: "Desk key" });
    expect(store.get(queryClientAtom).getQueryState(passkeysQueryKey)?.isInvalidated).toBe(true);
  });

  it("sends no name when none was given — the authenticator supplies a default", async () => {
    const store = freshStore();

    await store.set(addPasskeyAtom, "   ");

    expect(addPasskey).toHaveBeenCalledWith({});
  });

  it("stays silent on a cancelled ceremony, same as the sign-in path", async () => {
    const store = freshStore();
    addPasskey.mockResolvedValueOnce({
      data: null,
      error: { code: "REGISTRATION_CANCELLED", message: "cancelled" },
    });

    const ok = await store.set(addPasskeyAtom, "Desk key");

    expect(ok).toBe(false);
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it("surfaces a real failure in the shared error atom", async () => {
    const store = freshStore();
    addPasskey.mockResolvedValueOnce({ data: null, error: { message: "Not allowed" } });

    const ok = await store.set(addPasskeyAtom, "Desk key");

    expect(ok).toBe(false);
    expect(store.get(authErrorAtom)).toBe("Not allowed");
  });
});

describe("renamePasskeyAtom", () => {
  it("rejects an empty name before making a request", async () => {
    const store = freshStore();

    const ok = await store.set(renamePasskeyAtom, { id: "key-1", name: "  " });

    expect(ok).toBe(false);
    expect(updatePasskey).not.toHaveBeenCalled();
  });

  it("trims the name and invalidates the cached list on success", async () => {
    const store = freshStore();

    const ok = await store.set(renamePasskeyAtom, { id: "key-1", name: "  Travel key  " });

    expect(ok).toBe(true);
    expect(updatePasskey).toHaveBeenCalledWith({ id: "key-1", name: "Travel key" });
    expect(store.get(queryClientAtom).getQueryState(passkeysQueryKey)?.isInvalidated).toBe(true);
  });
});

describe("deletePasskeyAtom", () => {
  it("deletes the exact passkey and invalidates the cached list on success", async () => {
    const store = freshStore();

    const ok = await store.set(deletePasskeyAtom, "key-1");

    expect(ok).toBe(true);
    expect(deletePasskey).toHaveBeenCalledWith({ id: "key-1" });
    expect(store.get(queryClientAtom).getQueryState(passkeysQueryKey)?.isInvalidated).toBe(true);
  });

  it("surfaces a failure in the shared error atom", async () => {
    const store = freshStore();
    deletePasskey.mockResolvedValueOnce({ data: null, error: { message: "Not found" } });

    const ok = await store.set(deletePasskeyAtom, "key-1");

    expect(ok).toBe(false);
    expect(store.get(authErrorAtom)).toBe("Not found");
  });
});
