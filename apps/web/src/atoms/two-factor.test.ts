import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";

type AuthClientResult = { data: unknown; error: unknown };

const { verifyTotp, verifyOtp, verifyBackupCode, sendOtp } = vi.hoisted(() => ({
  verifyTotp: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
  verifyOtp: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
  verifyBackupCode: vi.fn((): Promise<AuthClientResult> =>
    Promise.resolve({ data: {}, error: null }),
  ),
  sendOtp: vi.fn((): Promise<AuthClientResult> => Promise.resolve({ data: {}, error: null })),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    twoFactor: { verifyTotp, verifyOtp, verifyBackupCode, sendOtp },
  },
}));

import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import {
  resetTwoFactorChallengeAtom,
  selectTwoFactorMethodAtom,
  selectedTwoFactorMethodAtom,
  sendTwoFactorOtpAtom,
  trustDeviceAtom,
  twoFactorCodeAtom,
  verifyTwoFactorAtom,
} from "@/atoms/two-factor";
import { m } from "@/paraglide/messages.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("selectTwoFactorMethodAtom", () => {
  it("switches the method and clears the half-typed code and the previous error", () => {
    const store = createStore();
    store.set(twoFactorCodeAtom, "123456");
    store.set(authErrorAtom, "Previous failure");

    store.set(selectTwoFactorMethodAtom, "backup");

    expect(store.get(selectedTwoFactorMethodAtom)).toBe("backup");
    expect(store.get(twoFactorCodeAtom)).toBe("");
    expect(store.get(authErrorAtom)).toBeNull();
  });
});

describe("resetTwoFactorChallengeAtom", () => {
  it("resets code, trust, method and error — the unmount cleanup of /two-factor", () => {
    const store = createStore();
    store.set(twoFactorCodeAtom, "123456");
    store.set(trustDeviceAtom, true);
    store.set(selectedTwoFactorMethodAtom, "backup");
    store.set(authErrorAtom, "Failure");

    store.set(resetTwoFactorChallengeAtom);

    expect(store.get(twoFactorCodeAtom)).toBe("");
    expect(store.get(trustDeviceAtom)).toBe(false);
    expect(store.get(selectedTwoFactorMethodAtom)).toBe("totp");
    expect(store.get(authErrorAtom)).toBeNull();
  });
});

describe("verifyTwoFactorAtom", () => {
  it("rejects an empty code without calling the transport", async () => {
    const store = createStore();

    const ok = await store.set(verifyTwoFactorAtom, "totp");

    expect(ok).toBe(false);
    expect(verifyTotp).not.toHaveBeenCalled();
    expect(store.get(authErrorAtom)).toBe("Please enter your verification code.");
  });

  it("dispatches to the TOTP endpoint with the code and trust flag, clearing the code on success", async () => {
    const store = createStore();
    store.set(twoFactorCodeAtom, "123456");
    store.set(trustDeviceAtom, true);

    const ok = await store.set(verifyTwoFactorAtom, "totp");

    expect(ok).toBe(true);
    expect(verifyTotp).toHaveBeenCalledWith({ code: "123456", trustDevice: true });
    expect(store.get(twoFactorCodeAtom)).toBe("");
  });

  it("dispatches to the email-OTP endpoint", async () => {
    const store = createStore();
    store.set(twoFactorCodeAtom, "654321");

    await store.set(verifyTwoFactorAtom, "otp");

    expect(verifyOtp).toHaveBeenCalledWith({ code: "654321", trustDevice: false });
  });

  it("dispatches to the backup-code endpoint", async () => {
    const store = createStore();
    store.set(twoFactorCodeAtom, "backup-1");

    await store.set(verifyTwoFactorAtom, "backup");

    expect(verifyBackupCode).toHaveBeenCalledWith({ code: "backup-1", trustDevice: false });
  });

  it("surfaces a server rejection in the shared error atom", async () => {
    const store = createStore();
    store.set(twoFactorCodeAtom, "123456");
    verifyTotp.mockResolvedValueOnce({ data: null, error: { message: "Invalid code" } });

    const ok = await store.set(verifyTwoFactorAtom, "totp");

    expect(ok).toBe(false);
    expect(store.get(authErrorAtom)).toBe("Invalid code");
  });

  it("toggles the shared pending flag around the request", async () => {
    const store = createStore();
    store.set(twoFactorCodeAtom, "123456");
    let release!: () => void;
    verifyTotp.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve({ data: {}, error: null });
      }),
    );

    const pending = store.set(verifyTwoFactorAtom, "totp");
    expect(store.get(authPendingAtom)).toBe(true);
    release();
    await pending;

    expect(store.get(authPendingAtom)).toBe(false);
  });

  it("falls back to the generic message when the transport itself throws", async () => {
    const store = createStore();
    store.set(twoFactorCodeAtom, "123456");
    verifyTotp.mockRejectedValueOnce(new Error("network down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await store.set(verifyTwoFactorAtom, "totp");

    expect(ok).toBe(false);
    expect(store.get(authErrorAtom)).toBe(m.common_something_went_wrong());
    expect(store.get(authPendingAtom)).toBe(false);
    consoleError.mockRestore();
  });
});

describe("sendTwoFactorOtpAtom", () => {
  it("requests an emailed code and reports success", async () => {
    const store = createStore();

    const ok = await store.set(sendTwoFactorOtpAtom);

    expect(ok).toBe(true);
    // No arguments — the endpoint needs none; a future caller passing some
    // would be a contract change this assertion pins.
    expect(sendOtp).toHaveBeenCalledWith();
  });

  it("surfaces a failure in the shared error atom", async () => {
    const store = createStore();
    sendOtp.mockResolvedValueOnce({ data: null, error: { message: "Rate limited" } });

    const ok = await store.set(sendTwoFactorOtpAtom);

    expect(ok).toBe(false);
    expect(store.get(authErrorAtom)).toBe("Rate limited");
  });
});
