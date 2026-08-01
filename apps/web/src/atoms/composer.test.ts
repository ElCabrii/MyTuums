import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { composerDraftAtom } from "@/atoms/composer";

const STORAGE_KEY = "my-tuums.composer-draft";

describe("composerDraftAtom", () => {
  it("defaults to an empty string with empty storage", () => {
    expect(createStore().get(composerDraftAtom)).toBe("");
  });

  it("reads back a stored draft", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("half-typed post"));
    const store = createStore();
    // `getOnInit` bakes the module-load-time read into the atom's initial
    // value; a fresh store only sees a newer one once something subscribes,
    // which is what re-triggers `onMount`'s re-read (see theme.test.ts).
    const unsub = store.sub(composerDraftAtom, () => {});
    expect(store.get(composerDraftAtom)).toBe("half-typed post");
    unsub();
  });

  it("falls back to '' when storage holds a non-string value", () => {
    // Simulates a hand-edited key, or a shape written by some future version
    // of the app — anything that isn't a string.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
    const store = createStore();
    const unsub = store.sub(composerDraftAtom, () => {});
    expect(store.get(composerDraftAtom)).toBe("");
    unsub();
  });

  it("falls back to '' when storage holds null", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(null));
    const store = createStore();
    const unsub = store.sub(composerDraftAtom, () => {});
    expect(store.get(composerDraftAtom)).toBe("");
    unsub();
  });

  it("persists writes to localStorage", () => {
    const store = createStore();
    store.set(composerDraftAtom, "gg wp");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toBe("gg wp");
    expect(store.get(composerDraftAtom)).toBe("gg wp");
  });
});
