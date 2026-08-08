import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";

/**
 * The two client calls under test, hoisted so the mock below and the
 * assertions here share the same functions.
 *
 * The result type is deliberately loose — `data`/`error` are widened so
 * `mockResolvedValueOnce` can hand back success, transport-error and
 * code-carrying variants, the way the atoms read them. BetterAuth's real
 * client types a union of all three; tests only need the union to fit.
 */
type AuthClientResult = { data: unknown; error: unknown };

const { requestPasswordReset, resetPassword } = vi.hoisted(() => ({
  requestPasswordReset: vi.fn((): Promise<AuthClientResult> =>
    Promise.resolve({ data: { status: true }, error: null }),
  ),
  resetPassword: vi.fn((): Promise<AuthClientResult> =>
    Promise.resolve({ data: { status: true }, error: null }),
  ),
}));

// A minimal nanostore-shaped double, exactly as in session.test.ts: `atoms/auth.ts`
// imports `waitForSignedOut` from lib/session-sync, which reads `sessionStore` at
// module scope — an absent export would crash the import, not the test.
const { state, listeners } = vi.hoisted(() => {
  const initial: { value: unknown } = { value: { data: null, isPending: true } };
  return { state: initial, listeners: new Set<(value: unknown) => void>() };
});

vi.mock("@/lib/auth-client", () => ({
  sessionStore: {
    get: () => state.value,
    subscribe: (listener: (value: unknown) => void) => {
      listeners.add(listener);
      listener(state.value);
      return () => listeners.delete(listener);
    },
  },
  authClient: { requestPasswordReset, resetPassword },
}));

import {
  authErrorAtom,
  forgotPasswordSentAtom,
  requestPasswordResetAtom,
  resetPasswordAtom,
  resetPasswordDoneAtom,
  resetPasswordInvalidAtom,
} from "@/atoms/auth";

describe("requestPasswordResetAtom", () => {
  it("sends the trimmed email with an absolute redirect to the reset page", async () => {
    const store = createStore();

    const ok = await store.set(requestPasswordResetAtom, "  alice@example.com  ");

    expect(ok).toBe(true);
    // The load-bearing property is *absolute*: the server resolves the
    // callback against its own baseURL, so a relative path would bounce to the
    // API origin. Asserted against the live `window.location.origin` rather
    // than a literal so the test does not depend on jsdom's default URL.
    expect(requestPasswordReset).toHaveBeenCalledWith({
      email: "alice@example.com",
      redirectTo: `${window.location.origin}/reset-password`,
    });
    expect(store.get(forgotPasswordSentAtom)).toBe(true);
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it("surfaces a transport error in the shared banner and reports failure", async () => {
    requestPasswordReset.mockResolvedValueOnce({
      data: null,
      error: { message: "Too many requests" },
    });
    const store = createStore();

    const ok = await store.set(requestPasswordResetAtom, "alice@example.com");

    expect(ok).toBe(false);
    expect(store.get(forgotPasswordSentAtom)).toBe(false);
    expect(store.get(authErrorAtom)).toBe("Too many requests");
  });
});

describe("resetPasswordAtom", () => {
  it("reports success and flips the done flag", async () => {
    const store = createStore();

    const outcome = await store.set(resetPasswordAtom, {
      token: "t1",
      newPassword: "password1",
    });

    expect(outcome).toEqual({ status: "success" });
    expect(resetPassword).toHaveBeenCalledWith({ token: "t1", newPassword: "password1" });
    expect(store.get(resetPasswordDoneAtom)).toBe(true);
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it("detects INVALID_TOKEN by error code — never by message — and shows the invalid-link panel", async () => {
    // The message is deliberately French: the i18n plugin can translate it, so
    // a message match would be locale-dependent. The code is the only stable
    // signal, and this asserts that is what the atom keys on.
    resetPassword.mockResolvedValueOnce({
      data: null,
      error: { code: "INVALID_TOKEN", message: "Jeton invalide" },
    });
    const store = createStore();

    const outcome = await store.set(resetPasswordAtom, {
      token: "expired",
      newPassword: "password1",
    });

    expect(outcome).toEqual({ status: "invalid-token" });
    expect(store.get(resetPasswordInvalidAtom)).toBe(true);
    expect(store.get(resetPasswordDoneAtom)).toBe(false);
    // No banner — the invalid-link panel already explains the failure.
    expect(store.get(authErrorAtom)).toBeNull();
  });

  it("surfaces any other error in the shared banner", async () => {
    resetPassword.mockResolvedValueOnce({
      data: null,
      error: { code: "PASSWORD_TOO_SHORT", message: "Password too short" },
    });
    const store = createStore();

    const outcome = await store.set(resetPasswordAtom, {
      token: "t1",
      newPassword: "short",
    });

    expect(outcome).toEqual({ status: "failed" });
    expect(store.get(resetPasswordInvalidAtom)).toBe(false);
    expect(store.get(resetPasswordDoneAtom)).toBe(false);
    expect(store.get(authErrorAtom)).toBe("Password too short");
  });
});
