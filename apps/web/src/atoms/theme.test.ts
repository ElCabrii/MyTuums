import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { resolvedThemeAtom, themeAtom } from "@/atoms/theme";

// `matchMedia` and `localStorage` are shimmed in src/test/setup.ts, and the
// latter is cleared in a global `afterEach` there. Each test still gets its
// own store — `themeAtom`/`resolvedThemeAtom` are module-level, but a fresh
// `createStore()` keeps in-memory atom state (systemThemeAtom's resolved
// value, its matchMedia subscription) from leaking between tests the way a
// shared default store would.

const STORAGE_KEY = "mytuums-ui-theme";

describe("themeAtom", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  it("defaults to system with empty storage", () => {
    expect(store.get(themeAtom)).toBe("system");
  });

  it("reads back a stored dark theme", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("dark"));
    const freshStore = createStore();
    // `getOnInit` bakes the storage read into the underlying atom's initial
    // value at module-load time (see jotai's `atomWithStorage` source) — the
    // exact behaviour `feed-scope.ts` relies on to avoid a first-paint flash,
    // since the real module import happens once, before any component ever
    // reads it. A later `createStore()` only sees a fresher value once
    // something subscribes, which is what re-triggers `onMount`'s re-read.
    // `useAtomValue` in a real component subscribes on mount; here that's
    // `store.sub`.
    const unsub = freshStore.sub(themeAtom, () => {});
    expect(freshStore.get(themeAtom)).toBe("dark");
    unsub();
  });

  it("falls back to system when storage holds garbage", () => {
    // Simulates a hand-edited or stale key — anything that isn't one of the
    // three real theme values. This is defect 1: the old provider cast this
    // straight to `Theme`, so a value like this would have reached
    // `classList.add("blue")`, applying neither light nor dark.
    localStorage.setItem(STORAGE_KEY, JSON.stringify("blue"));
    const freshStore = createStore();
    const unsub = freshStore.sub(themeAtom, () => {});
    expect(freshStore.get(themeAtom)).toBe("system");
    unsub();
  });

  it("persists writes to localStorage", () => {
    store.set(themeAtom, "light");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toBe("light");
    expect(store.get(themeAtom)).toBe("light");
  });
});

describe("resolvedThemeAtom", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  it("follows the system atom when theme is system", () => {
    // The shim in setup.ts fixes `matches: false`, so the system value
    // starts resolved to "light".
    expect(store.get(themeAtom)).toBe("system");
    expect(store.get(resolvedThemeAtom)).toBe("light");
  });

  it("ignores the system value once the theme is explicitly dark", () => {
    store.set(themeAtom, "dark");
    expect(store.get(resolvedThemeAtom)).toBe("dark");
  });

  it("ignores the system value once the theme is explicitly light", () => {
    store.set(themeAtom, "light");
    expect(store.get(resolvedThemeAtom)).toBe("light");
  });

  it("updates live when the OS preference changes while system is mounted (defect 2)", () => {
    // This is the regression test for the old provider's second defect: it
    // only ever read `matchMedia(...).matches` once inside a `useEffect`, so
    // an OS theme switch while the app was open did nothing until reload.
    //
    // `window.matchMedia` is wrapped (not replaced) so the underlying shim
    // from setup.ts still creates the MediaQueryList; wrapping just captures
    // the instance `systemThemeAtom.onMount` subscribes to, so the test can
    // dispatch a synthetic "change" event through it the way a real browser
    // would when the OS preference flips.
    const originalMatchMedia = window.matchMedia.bind(window);
    let capturedMql: MediaQueryList | undefined;
    window.matchMedia = (query: string): MediaQueryList => {
      capturedMql = originalMatchMedia(query);
      return capturedMql;
    };

    try {
      const freshStore = createStore();
      // Subscribing is what triggers `onMount` — a bare `store.get()` never
      // mounts an atom, since there is nothing to notify on a later change.
      const unsub = freshStore.sub(resolvedThemeAtom, () => {});

      expect(freshStore.get(resolvedThemeAtom)).toBe("light");
      expect(capturedMql).toBeDefined();

      capturedMql!.dispatchEvent({ matches: true } as MediaQueryListEvent);

      expect(freshStore.get(resolvedThemeAtom)).toBe("dark");

      unsub();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
