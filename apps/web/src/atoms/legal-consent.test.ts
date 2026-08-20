import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";
import { authClient } from "@/lib/auth-client";
import { m } from "@/paraglide/messages.js";
import {
  patchTestSessionUser,
  setTestSession,
  signedInSession,
  signedOutSession,
} from "@/test/auth-fixture";
import { sessionAtom } from "@/atoms/session";
import {
  acceptLegalConsentAtom,
  legalConsentCheckboxAtom,
  legalConsentErrorAtom,
  legalConsentModeAtom,
  legalConsentPendingAtom,
  legalConsentRequiredAtom,
} from "@/atoms/legal-consent";

const subscriptions: (() => void)[] = [];

/**
 * A store with `sessionAtom` mounted. `sessionAtom` is seeded at module import
 * and only tracks the session store through its `onMount` subscription (see
 * atoms/session.ts), so a bare `createStore()` never sees `setTestSession`.
 * Subscribing arms that mount, and `subscribe` fires immediately with the
 * current value, so the store is in sync before the first `get`.
 */
function mountedStore() {
  const store = createStore();
  subscriptions.push(store.sub(sessionAtom, () => undefined));
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  setTestSession(signedOutSession());
});

afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
});

describe("legalConsentRequiredAtom", () => {
  it("is false while signed out", () => {
    const store = mountedStore();

    expect(store.get(legalConsentRequiredAtom)).toBe(false);
  });

  it("is true when a signed-in account has never accepted legal documents", () => {
    setTestSession(
      signedInSession({
        legalAcceptedAt: null,
        legalVersion: null,
      }),
    );
    const store = mountedStore();

    expect(store.get(legalConsentRequiredAtom)).toBe(true);
    expect(store.get(legalConsentModeAtom)).toBe("missing");
  });

  it("is true when the accepted legal version is stale", () => {
    setTestSession(
      signedInSession({
        legalAcceptedAt: new Date("2020-01-01T00:00:00.000Z"),
        legalVersion: "2020-01-01",
      }),
    );
    const store = mountedStore();

    expect(store.get(legalConsentRequiredAtom)).toBe(true);
    expect(store.get(legalConsentModeAtom)).toBe("update");
  });

  it("is false when the accepted legal version is current", () => {
    setTestSession(
      signedInSession({
        legalAcceptedAt: new Date("2026-08-02T00:00:00.000Z"),
        legalVersion: LEGAL_VERSION,
      }),
    );
    const store = mountedStore();

    expect(store.get(legalConsentRequiredAtom)).toBe(false);
  });
});

describe("acceptLegalConsentAtom", () => {
  it("refuses to save until the checkbox is ticked", async () => {
    setTestSession(
      signedInSession({
        legalAcceptedAt: null,
        legalVersion: null,
      }),
    );
    const store = mountedStore();

    await expect(store.set(acceptLegalConsentAtom)).resolves.toBe(false);

    expect(authClient.updateUser).not.toHaveBeenCalled();
    expect(store.get(legalConsentErrorAtom)).toBe(m.legal_consent_required());
  });

  it("records the current legal version and waits for the session to catch up", async () => {
    setTestSession(
      signedInSession({
        legalAcceptedAt: new Date("2020-01-01T00:00:00.000Z"),
        legalVersion: "2020-01-01",
      }),
    );
    const store = mountedStore();
    store.set(legalConsentCheckboxAtom, true);

    vi.mocked(authClient.updateUser).mockImplementation(() => {
      patchTestSessionUser({
        legalAcceptedAt: new Date("2026-08-02T00:00:00.000Z"),
        legalVersion: LEGAL_VERSION,
      });
      return Promise.resolve({ data: {}, error: null });
    });

    await expect(store.set(acceptLegalConsentAtom)).resolves.toBe(true);

    // SAFETY: Vitest's asymmetric matcher is intentionally passed through
    // `unknown`; `objectContaining` recognizes it at runtime by shape.
    const isoDateMatcher: unknown = expect.stringMatching(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    ) as unknown;
    expect(authClient.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        legalAcceptedAt: isoDateMatcher,
        legalVersion: LEGAL_VERSION,
      }),
    );
    expect(store.get(legalConsentCheckboxAtom)).toBe(false);
    expect(store.get(legalConsentPendingAtom)).toBe(false);
    expect(store.get(legalConsentErrorAtom)).toBeNull();
  });

  it("keeps the dialog open and reports the server error", async () => {
    setTestSession(
      signedInSession({
        legalAcceptedAt: null,
        legalVersion: null,
      }),
    );
    const store = mountedStore();
    store.set(legalConsentCheckboxAtom, true);

    vi.mocked(authClient.updateUser).mockResolvedValue({
      data: null,
      error: { message: "Could not save consent." },
    });

    await expect(store.set(acceptLegalConsentAtom)).resolves.toBe(false);

    expect(store.get(legalConsentCheckboxAtom)).toBe(true);
    expect(store.get(legalConsentPendingAtom)).toBe(false);
    expect(store.get(legalConsentErrorAtom)).toBe("Could not save consent.");
  });
});
