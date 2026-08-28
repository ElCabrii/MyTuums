import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { installInMemoryStorage } from "@/test/memory-storage";

const STORAGE_KEY = "my-tuums.avatar-upgrade-dismissed";

// These tests assert persistence, so they install the storage they assert on —
// the node setup deliberately provides no global `localStorage`.
installInMemoryStorage();

/**
 * `avatarUpgradeDismissalAtom` reads `getOnInit: true` off `atomWithStorage`,
 * which reads `localStorage` synchronously when the module is first evaluated.
 * Each test seeds storage and then imports a brand new copy of the module via
 * `vi.resetModules()`, mirroring a real page load rather than reusing whatever
 * a previous import already froze in (same harness as `feed-scope.test.ts`).
 */
async function freshDismissalAtom() {
  vi.resetModules();
  const mod = await import("@/atoms/avatar-upgrade");
  return mod.avatarUpgradeDismissalAtom;
}

describe("avatarUpgradeDismissalAtom", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("reads no dismissal when nothing is stored", async () => {
    const avatarUpgradeDismissalAtom = await freshDismissalAtom();
    expect(createStore().get(avatarUpgradeDismissalAtom)).toBeNull();
  });

  it("persists the dismissed avatar URL and reads it back after a reload", async () => {
    const avatarUpgradeDismissalAtom = await freshDismissalAtom();
    const store = createStore();

    store.set(avatarUpgradeDismissalAtom, "/media/abc.webp");

    expect(localStorage.getItem(STORAGE_KEY)).toBe('"/media/abc.webp"');
    expect(store.get(avatarUpgradeDismissalAtom)).toBe("/media/abc.webp");

    const reloaded = await freshDismissalAtom();
    expect(createStore().get(reloaded)).toBe("/media/abc.webp");
  });

  it("clears back to no dismissal", async () => {
    const avatarUpgradeDismissalAtom = await freshDismissalAtom();
    const store = createStore();
    store.set(avatarUpgradeDismissalAtom, "/media/abc.webp");

    store.set(avatarUpgradeDismissalAtom, null);

    expect(store.get(avatarUpgradeDismissalAtom)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("null");
  });

  // localStorage is user-editable and outlives deploys. A corrupt entry must
  // never suppress a prompt, so anything unrecognised collapses to "not
  // dismissed" — the failure mode is an extra prompt, not a missing one.
  describe("collapses an untrustworthy stored value to no dismissal", () => {
    it.each([
      ["a JSON number", "42"],
      ["a JSON boolean", "true"],
      ["an empty string", '""'],
      ["malformed JSON", "{not-json"],
    ])("%s", async (_label, raw) => {
      localStorage.setItem(STORAGE_KEY, raw);
      const avatarUpgradeDismissalAtom = await freshDismissalAtom();
      expect(createStore().get(avatarUpgradeDismissalAtom)).toBeNull();
    });
  });
});
