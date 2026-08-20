import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { installTestAuthClient } from "@/lib/auth-client";

type AuthClientResult = { data: unknown; error: unknown };

const { signInEmail, signInUsername, signInPasskey, signUpEmail } = vi.hoisted(() => ({
  signInEmail: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
  signInUsername: vi.fn((): Promise<AuthClientResult> =>
    Promise.resolve({ data: {}, error: null }),
  ),
  signInPasskey: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
  signUpEmail: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
}));

// SAFETY: the recording fakes resolve the { data, error } shapes the app reads
// from the real client; the seam swaps only what each suite needs.
installTestAuthClient({
  authClient: {
    signIn: {
      email: signInEmail,
      username: signInUsername,
      passkey: signInPasskey,
    },
    signUp: {
      email: signUpEmail,
    },
  },
});

import { authErrorAtom, signInAtom, signInWithPasskeyAtom, signUpAtom } from "@/atoms/auth";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The admin plugin's `session.create.before` hook throws this code — never a
 * message a test should pattern-match on, since the i18n plugin may have
 * translated it (see `errorCodeOf`'s docblock in atoms/auth.ts).
 */
const bannedError = {
  code: "BANNED_USER",
  message:
    "You have been banned from this application. Please contact support if you believe this is an error.",
};

describe("signInAtom", () => {
  it('reports "banned" and leaves the banner unset on BANNED_USER — issue #74', async () => {
    const store = createStore();
    signInEmail.mockResolvedValueOnce({ data: null, error: bannedError });

    const outcome = await store.set(signInAtom, {
      identifier: "banned@example.com",
      password: "whatever1",
    });

    expect(outcome).toEqual({ status: "banned" });
    // The whole point: a banned account does not get the generic sign-in
    // banner, because the caller navigates to `/banned` on this outcome
    // instead (see login.tsx) — a set banner here would mean both paths fire.
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it("still sets the banner for an ordinary sign-in failure", async () => {
    const store = createStore();
    signInEmail.mockResolvedValueOnce({
      data: null,
      error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
    });

    const outcome = await store.set(signInAtom, {
      identifier: "alice@example.com",
      password: "wrong",
    });

    expect(outcome).toEqual({ status: "failed" });
    expect(store.get(authErrorAtom)).toBe("Invalid email or password");
  });

  it('resolves "signed-in" and touches nothing on success', async () => {
    const store = createStore();
    signInUsername.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });

    const outcome = await store.set(signInAtom, { identifier: "alice", password: "whatever1" });

    expect(outcome).toEqual({ status: "signed-in" });
    expect(store.get(authErrorAtom)).toBeNull();
  });
});

describe("signInWithPasskeyAtom", () => {
  it('resolves "banned" and leaves the banner unset on BANNED_USER — issue #74', async () => {
    const store = createStore();
    signInPasskey.mockResolvedValueOnce({ data: null, error: bannedError });

    await expect(store.set(signInWithPasskeyAtom)).resolves.toBe("banned");
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it("stays silent on a cancelled ceremony, same as before this issue", async () => {
    const store = createStore();
    signInPasskey.mockResolvedValueOnce({
      data: null,
      error: { code: "AUTH_CANCELLED", message: "cancelled" },
    });

    await expect(store.set(signInWithPasskeyAtom)).resolves.toBe("failed");
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it('resolves "signed-in" on success', async () => {
    const store = createStore();
    signInPasskey.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });

    await expect(store.set(signInWithPasskeyAtom)).resolves.toBe("signed-in");
  });
});

describe("signUpAtom", () => {
  it("sends legal acceptance evidence only when the box is checked", async () => {
    const store = createStore();

    await store.set(signUpAtom, {
      username: "alice",
      name: "Alice",
      email: "alice@example.com",
      password: "password1",
      dateOfBirth: "1995-01-01",
      legalAccepted: true,
    });

    // SAFETY: Vitest's asymmetric matcher is intentionally passed through
    // `unknown`; `objectContaining` recognizes it at runtime by shape.
    const isoDateMatcher: unknown = expect.stringMatching(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    ) as unknown;
    expect(signUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        legalVersion: LEGAL_VERSION,
        legalAcceptedAt: isoDateMatcher,
      }),
    );
  });

  it("omits legal acceptance evidence when the box is unchecked", async () => {
    const store = createStore();

    await store.set(signUpAtom, {
      username: "alice",
      name: "Alice",
      email: "alice@example.com",
      password: "password1",
      dateOfBirth: "1995-01-01",
      legalAccepted: false,
    });

    expect(signUpEmail).toHaveBeenCalledWith(
      expect.not.objectContaining({
        legalAcceptedAt: undefined,
        legalVersion: undefined,
      }),
    );
  });
});
