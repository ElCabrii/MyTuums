import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { installInMemoryStorage } from "@/test/memory-storage";

const STORAGE_KEY = "my-tuums.seen-changelog-version";

installInMemoryStorage();

async function freshSeenVersionAtom() {
  vi.resetModules();
  return (await import("@/atoms/changelog")).seenChangelogVersionAtom;
}

describe("seenChangelogVersionAtom", () => {
  afterEach(() => vi.resetModules());

  it("persists a valid release version and restores it after reload", async () => {
    const seenVersionAtom = await freshSeenVersionAtom();
    const store = createStore();

    store.set(seenVersionAtom, "0.5.0");

    expect(localStorage.getItem(STORAGE_KEY)).toBe('"0.5.0"');
    const reloadedAtom = await freshSeenVersionAtom();
    expect(createStore().get(reloadedAtom)).toBe("0.5.0");
  });

  it.each(["42", '""', '"v0.5.0"', "{not-json"])(
    "sanitises an invalid persisted value: %s",
    async (stored) => {
      localStorage.setItem(STORAGE_KEY, stored);

      const seenVersionAtom = await freshSeenVersionAtom();

      expect(createStore().get(seenVersionAtom)).toBeNull();
    },
  );
});
