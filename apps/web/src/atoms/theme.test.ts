import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { resolvedThemeAtom, themeAtom, themeClassEffect } from "@/atoms/theme";

const STORAGE_KEY = "mytuums-ui-theme";
const originalMatchMedia = globalThis.matchMedia;

/**
 * Installs a single, stable `MediaQueryList` double so a test can both
 * trigger `theme.ts`'s internal `matchDarkScheme()` calls AND dispatch
 * "change" events at the exact listener that call registered — the shared
 * setup.ts stub hands back a fresh object (and a fresh, empty listener set)
 * on every call, which would make a test's own `dispatchEvent` a no-op
 * against whatever `theme.ts` itself is holding.
 */
function installMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, cb: EventListenerOrEventListenerObject) =>
      void listeners.add(cb as (event: MediaQueryListEvent) => void),
    removeEventListener: (_type: string, cb: EventListenerOrEventListenerObject) =>
      void listeners.delete(cb as (event: MediaQueryListEvent) => void),
  } as unknown as MediaQueryList;

  globalThis.matchMedia = vi.fn().mockReturnValue(mql);

  return {
    fireChange: (nextMatches: boolean) => {
      Object.assign(mql, { matches: nextMatches });
      listeners.forEach((listener) => listener({ matches: nextMatches } as MediaQueryListEvent));
    },
  };
}

afterEach(() => {
  globalThis.matchMedia = originalMatchMedia;
});

describe("default resolution from matchMedia", () => {
  // `systemThemeAtom`'s initial value is captured once, at module import —
  // proving "the default follows the OS" requires the OS preference to
  // already be in place BEFORE that import happens, hence the fresh module.
  it("resolves to dark when the OS prefers dark and no explicit choice is stored", async () => {
    installMatchMedia(true);
    vi.resetModules();
    const fresh = await import("@/atoms/theme");

    expect(createStore().get(fresh.resolvedThemeAtom)).toBe("dark");
  });

  it("resolves to light when the OS prefers light and no explicit choice is stored", async () => {
    installMatchMedia(false);
    vi.resetModules();
    const fresh = await import("@/atoms/theme");

    expect(createStore().get(fresh.resolvedThemeAtom)).toBe("light");
  });
});

describe("explicit choice overrides the system preference", () => {
  it("light stays light even when the OS prefers dark", () => {
    installMatchMedia(true);
    const store = createStore();
    store.set(themeAtom, "light");
    expect(store.get(resolvedThemeAtom)).toBe("light");
  });

  it("dark stays dark even when the OS prefers light", () => {
    installMatchMedia(false);
    const store = createStore();
    store.set(themeAtom, "dark");
    expect(store.get(resolvedThemeAtom)).toBe("dark");
  });
});

describe("persistence", () => {
  it("writing a theme persists to localStorage and a fresh store reads it back", async () => {
    const store = createStore();
    store.set(themeAtom, "dark");

    expect(localStorage.getItem(STORAGE_KEY)).toBe('"dark"');

    vi.resetModules();
    const fresh = await import("@/atoms/theme");
    expect(createStore().get(fresh.themeAtom)).toBe("dark");
  });
});

describe("onMount subscription", () => {
  it("reacts to a dispatched OS theme-change event while mounted", () => {
    // `matchDarkScheme()` is called fresh inside `onMount`, not reused from
    // module-import time, so installing the double before subscribing is
    // enough — no module reset needed here.
    const { fireChange } = installMatchMedia(false);
    const store = createStore();
    store.set(themeAtom, "system");

    const seen: string[] = [];
    const unsub = store.sub(resolvedThemeAtom, () => seen.push(store.get(resolvedThemeAtom)));
    expect(store.get(resolvedThemeAtom)).toBe("light");

    fireChange(true);
    expect(store.get(resolvedThemeAtom)).toBe("dark");
    expect(seen).toContain("dark");

    unsub();
  });
});

describe("themeClassEffect", () => {
  it("applies and swaps the class on document.documentElement", () => {
    document.documentElement.className = "";
    const store = createStore();
    store.set(themeAtom, "dark");

    const unsub = store.sub(themeClassEffect, () => {});
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);

    store.set(themeAtom, "light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    unsub();
  });
});
