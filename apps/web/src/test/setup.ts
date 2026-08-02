import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Node >= 22 ships its own `localStorage` global, which is `undefined` unless
 * the process was started with `--localstorage-file`. Under jsdom `window`
 * *is* `globalThis`, so that undefined global shadows the working
 * implementation jsdom provides, and anything reading `localStorage` —
 * `feedScopeAtom`, `composerDraftAtom`, `themeAtom` — silently gets nothing.
 *
 * Jotai swallows it (its storage getter is null-safe), so the failure mode is
 * not a crash but a preference that never persists: exactly the behaviour
 * several tests here exist to assert on. An in-memory shim restores it.
 */
if (!globalThis.localStorage) {
  const entries = new Map<string, string>();

  globalThis.localStorage = {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
    clear: () => entries.clear(),
  };
}

/**
 * jsdom does not implement `matchMedia` at all — reading it throws
 * "matchMedia is not a function", and `atoms/theme.ts` subscribes to OS theme
 * changes through it in `onMount`.
 *
 * The stub implements BOTH the modern `addEventListener`/`removeEventListener`
 * pair and the legacy `addListener`/`removeListener` pair, because those are
 * the two a theme atom has to handle across browsers — a double that supported
 * only one would let "subscribed with the wrong method" pass silently.
 *
 * `matches: false` means "prefers light": arbitrary, but deterministic.
 * Individual tests override `globalThis.matchMedia` when they need dark.
 */
if (!globalThis.matchMedia) {
  globalThis.matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();

    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
        void listeners.add(listener as (event: MediaQueryListEvent) => void),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
        void listeners.delete(listener as (event: MediaQueryListEvent) => void),
      addListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
        if (listener) listeners.add(listener);
      },
      removeListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
        if (listener) listeners.delete(listener);
      },
      dispatchEvent: (event: Event) => {
        listeners.forEach((listener) => listener(event as MediaQueryListEvent));
        return true;
      },
    };
  };
}

/**
 * `globals: false` means Testing Library's own auto-cleanup — which hooks a
 * global `afterEach` — never registers, so unmounting between tests has to be
 * wired up here. Without it every render stays in the document and `getByRole`
 * starts failing with "found multiple elements".
 */
afterEach(() => {
  cleanup();
});

/**
 * The `localStorage` shim above has no per-test lifetime of its own, so a
 * value written by one test is still there for the next one that reads the
 * same key. Persisted atoms (`feedScopeAtom`, `composerDraftAtom`, the theme)
 * are the ones this bites.
 */
afterEach(() => {
  globalThis.localStorage?.clear();
});
