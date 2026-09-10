import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { ANALYTICS_CONSENT_LIFETIME_MS } from "@/lib/analytics-config";
import { installInMemoryStorage } from "@/test/memory-storage";

const STORAGE_KEY = "my-tuums.analytics-consent";
const NOW = new Date("2026-09-06T12:00:00.000Z");

installInMemoryStorage();

async function freshConsentAtom() {
  vi.resetModules();
  return (await import("@/atoms/analytics-consent")).analyticsConsentAtom;
}

async function freshExpiryAtom() {
  vi.resetModules();
  return (await import("@/atoms/analytics-consent")).analyticsConsentExpiresAtAtom;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("analyticsConsentAtom", () => {
  it("persists either explicit choice with the decision time", async () => {
    const consentAtom = await freshConsentAtom();
    const store = createStore();

    store.set(consentAtom, "denied");

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      decision: "denied",
      decidedAt: NOW.getTime(),
    });
    expect(store.get(consentAtom)).toBe("denied");
  });

  it("treats a six-month-old choice as absent so the banner asks again", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        decision: "granted",
        decidedAt: NOW.getTime() - ANALYTICS_CONSENT_LIFETIME_MS,
      }),
    );

    const consentAtom = await freshConsentAtom();

    expect(createStore().get(consentAtom)).toBeNull();
  });

  it.each([
    "not an object",
    { decision: "maybe", decidedAt: NOW.getTime() },
    { decision: "granted", decidedAt: NOW.getTime() + 1 },
  ])("sanitises an invalid persisted value: %j", async (stored) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const consentAtom = await freshConsentAtom();

    expect(createStore().get(consentAtom)).toBeNull();
  });

  it("removes the persisted record when cleared", async () => {
    const consentAtom = await freshConsentAtom();
    const store = createStore();
    store.set(consentAtom, "granted");

    store.set(consentAtom, null);

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(store.get(consentAtom)).toBeNull();
  });
});

describe("analyticsConsentExpiresAtAtom", () => {
  it("returns the six-month boundary for a valid choice", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ decision: "granted", decidedAt: NOW.getTime() }),
    );

    const expiryAtom = await freshExpiryAtom();

    expect(createStore().get(expiryAtom)).toBe(NOW.getTime() + ANALYTICS_CONSENT_LIFETIME_MS);
  });

  it("returns null when there is no valid choice to expire", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        decision: "granted",
        decidedAt: NOW.getTime() - ANALYTICS_CONSENT_LIFETIME_MS,
      }),
    );

    const expiredAtom = await freshExpiryAtom();
    expect(createStore().get(expiredAtom)).toBeNull();

    localStorage.removeItem(STORAGE_KEY);
    const missingAtom = await freshExpiryAtom();
    expect(createStore().get(missingAtom)).toBeNull();
  });
});
