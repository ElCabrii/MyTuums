import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { installTestAuthClient } from "@/lib/auth-client";

type AuthClientResult = { data: unknown; error: unknown };

const { updateUser, changePassword } = vi.hoisted(() => ({
  updateUser: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
  changePassword: vi.fn((): Promise<AuthClientResult> =>
    Promise.resolve({ data: {}, error: null }),
  ),
}));

/**
 * A nanostore-shaped session double whose value tests can advance.
 *
 * `changeHandleAtom` awaits `waitForSession(...)` — the same gap
 * `atoms/handle-claim.ts` closes — so a test that never moves the store would
 * hang until that helper's 3s timeout. `setSession` below is what lets a test
 * land the refetch deliberately.
 */
type AccountSessionState = { value: AccountSessionFixture };
type AccountSessionFixture = {
  data: {
    user: { id: string; name: string; username: string | null; displayUsername: string | null };
  } | null;
  isPending: boolean;
};

const { state, listeners } = vi.hoisted(() => {
  const initial: AccountSessionState = { value: { data: null, isPending: false } };
  return { state: initial, listeners: new Set<(value: AccountSessionFixture) => void>() };
});

// SAFETY: the recording fakes resolve the { data, error } shapes the app reads
// from the real client; the seam swaps only what each suite needs.
installTestAuthClient({
  sessionStore: {
    get: () => state.value,
    subscribe: (listener: (value: AccountSessionFixture) => void) => {
      listeners.add(listener);
      listener(state.value);
      return () => listeners.delete(listener);
    },
  },
  authClient: { updateUser, changePassword },
});

import { authErrorAtom } from "@/atoms/auth";
import {
  changeHandleAtom,
  changePasswordAtom,
  confirmNewPasswordAtom,
  currentPasswordAtom,
  handleChangeDraftAtom,
  newPasswordAtom,
  passwordChangedAtom,
} from "@/atoms/account";
import { sessionAtom } from "@/atoms/session";

function setSession(value: AccountSessionFixture) {
  state.value = value;
  listeners.forEach((listener) => listener(value));
}

function signedIn(username: string | null) {
  return {
    data: { user: { id: "u1", name: "Alex Mercer", username, displayUsername: username } },
    isPending: false,
  };
}

function freshStore() {
  const store = createStore();
  store.set(queryClientAtom, new QueryClient());
  // SAFETY: the fixture is deliberately partial — the atom only reads the two
  // session fields these tests exercise (see the note above the seam install).
  store.set(sessionAtom, state.value as never);
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  setSession(signedIn("alexmercer"));
});

describe("changeHandleAtom", () => {
  it("rejects an invalid handle before making a request", async () => {
    const store = freshStore();
    store.set(handleChangeDraftAtom, "no spaces!");

    await expect(store.set(changeHandleAtom)).resolves.toBeNull();
    expect(updateUser).not.toHaveBeenCalled();
    expect(store.get(authErrorAtom)).toMatch(/letters, numbers/);
  });

  it("returns the NORMALISED handle read back off the refreshed session", async () => {
    const store = freshStore();
    store.set(handleChangeDraftAtom, "AlexMercer2");

    updateUser.mockImplementationOnce(() => {
      // Better Auth's own refetch, which `waitForSession` is waiting on. Both
      // handle fields now carry the canonical lowercase representation.
      setSession({
        data: {
          user: {
            id: "u1",
            name: "Alex Mercer",
            username: "alexmercer2",
            displayUsername: "alexmercer2",
          },
        },
        isPending: false,
      });
      // SAFETY: deliberately partial fixture, same boundary as `freshStore` above.
      store.set(sessionAtom, state.value as never);
      return Promise.resolve({ data: {}, error: null });
    });

    // The lower-cased form is what profile URLs and `profileAtomFamily` key on,
    // so returning the typed casing would fragment the cache.
    await expect(store.set(changeHandleAtom)).resolves.toBe("alexmercer2");
    expect(updateUser).toHaveBeenCalledWith({ username: "alexmercer2" });
  });

  it("short-circuits when the handle differs only in casing from the current one", async () => {
    const store = freshStore();
    store.set(handleChangeDraftAtom, "AlexMercer");

    // Already this account's handle once normalised — a round trip would report
    // success for a change that did not happen.
    await expect(store.set(changeHandleAtom)).resolves.toBe("alexmercer");
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("surfaces the server's message and returns null when the handle is taken", async () => {
    const store = freshStore();
    store.set(handleChangeDraftAtom, "taken");
    updateUser.mockResolvedValueOnce({
      data: null,
      error: { message: "Username is already taken." },
    });

    await expect(store.set(changeHandleAtom)).resolves.toBeNull();
    // Passed through rather than replaced, which is what lets the BetterAuth
    // i18n plugin's already-translated message reach the banner intact.
    expect(store.get(authErrorAtom)).toBe("Username is already taken.");
  });
});

describe("changePasswordAtom", () => {
  it("requires the current password", async () => {
    const store = freshStore();
    store.set(newPasswordAtom, "newpassword1");
    store.set(confirmNewPasswordAtom, "newpassword1");

    await expect(store.set(changePasswordAtom)).resolves.toBe(false);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("revokes other sessions — the point of changing a password you think is known", async () => {
    const store = freshStore();
    store.set(currentPasswordAtom, "oldpassword");
    store.set(newPasswordAtom, "newpassword1");
    store.set(confirmNewPasswordAtom, "newpassword1");

    await expect(store.set(changePasswordAtom)).resolves.toBe(true);
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: "oldpassword",
      newPassword: "newpassword1",
      revokeOtherSessions: true,
    });
  });

  it("clears the fields and reports success, so the form does not hold a password", async () => {
    const store = freshStore();
    store.set(currentPasswordAtom, "oldpassword");
    store.set(newPasswordAtom, "newpassword1");
    store.set(confirmNewPasswordAtom, "newpassword1");

    await store.set(changePasswordAtom);

    expect(store.get(currentPasswordAtom)).toBe("");
    expect(store.get(newPasswordAtom)).toBe("");
    expect(store.get(confirmNewPasswordAtom)).toBe("");
    expect(store.get(passwordChangedAtom)).toBe(true);
  });

  it("keeps the fields and reports failure when the current password is wrong", async () => {
    const store = freshStore();
    store.set(currentPasswordAtom, "wrong");
    store.set(newPasswordAtom, "newpassword1");
    store.set(confirmNewPasswordAtom, "newpassword1");
    changePassword.mockResolvedValueOnce({
      data: null,
      error: { message: "Invalid password" },
    });

    await expect(store.set(changePasswordAtom)).resolves.toBe(false);
    expect(store.get(authErrorAtom)).toBe("Invalid password");
    expect(store.get(passwordChangedAtom)).toBe(false);
    // Not cleared: retyping everything after a typo would be its own small
    // punishment, and nothing has left the browser that needs scrubbing.
    expect(store.get(newPasswordAtom)).toBe("newpassword1");
  });
});
