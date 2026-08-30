import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { sessionAtom } from "@/atoms/session";
import { resolvedThemeAtom, themeAtom, themeClassEffect } from "@/atoms/theme";

const STORAGE_KEY = "mytuums-ui-theme";
const originalMatchMedia = globalThis.matchMedia;

/**
 * Installs a single, stable `MediaQueryList` double so a test can both
 * trigger `theme.ts`'s internal `matchDarkScheme()` calls AND dispatch
 * "change" events at the exact listener that call registered — the shared
 * setup-dom.ts stub hands back a fresh object (and a fresh, empty listener set)
 * on every call, which would make a test's own `dispatchEvent` a no-op
 * against whatever `theme.ts` itself is holding.
 */
function installMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
      if (cb instanceof Function) listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
      if (cb instanceof Function) listeners.delete(cb);
    },
  };

  globalThis.matchMedia = vi.fn().mockReturnValue(mql);

  return {
    fireChange: (nextMatches: boolean) => {
      Object.assign(mql, { matches: nextMatches });
      // SAFETY: listeners were registered through addEventListener above, so
      // every one accepts the MediaQueryListEvent shape dispatched here.
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

/**
 * The account's stored default sits between "this device chose" and "follow the
 * OS". That order is the whole feature: the header toggle overrides on the
 * device you are sitting at, and `/settings/account` sets what a device that has
 * never been told anything falls back to.
 */
describe("account theme preference", () => {
  function withPreference(themePreference: string | null) {
    const store = createStore();
    // SAFETY: (`as never`) the store's value type is the full nanostore session shape
    // (isRefetching, refetch, ...) and a fixture has no business rebuilding it —
    // only the two fields `themeAtom` reads matter here.
    store.set(sessionAtom, {
      data: { user: { id: "u1", name: "Alex Mercer", themePreference } },
      isPending: false,
    } as never);
    return store;
  }

  it("applies on a device that has never chosen", () => {
    installMatchMedia(false);
    expect(withPreference("dark").get(themeAtom)).toBe("dark");
  });

  it("loses to this device's own choice", () => {
    installMatchMedia(false);
    const store = withPreference("dark");
    store.set(themeAtom, "light");
    expect(store.get(themeAtom)).toBe("light");
  });

  it("loses to a stored 'system', which is a real choice and not an absence", () => {
    // This is precisely why `storedThemeAtom` defaults to null rather than
    // "system": with "system" as the default, "I picked system here" and "I
    // have never touched this" would be the same value, and the account
    // preference could never apply on any device.
    installMatchMedia(false);
    const store = withPreference("dark");
    store.set(themeAtom, "system");
    expect(store.get(themeAtom)).toBe("system");
    expect(store.get(resolvedThemeAtom)).toBe("light");
  });

  it("is ignored when unrecognised — it arrives off the wire", () => {
    installMatchMedia(false);
    expect(withPreference("chartreuse").get(themeAtom)).toBe("system");
  });

  it("leaves a signed-out visitor on 'system'", () => {
    installMatchMedia(false);
    const store = createStore();
    // SAFETY: partial session fixture — only the signed-out shape matters here.
    store.set(sessionAtom, { data: null, isPending: false } as never);
    expect(store.get(themeAtom)).toBe("system");
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
