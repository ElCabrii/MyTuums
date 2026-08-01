import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Node >= 22 ships its own `localStorage` global, which is `undefined` unless
// the process was started with `--localstorage-file`. Under vitest's jsdom
// environment `window` *is* `globalThis`, so that undefined global shadows the
// working implementation jsdom provides and anything reading `localStorage` —
// e.g. `feedScopeAtom` in src/lib/feed-scope.ts — silently gets nothing.
// jotai swallows that (its storage getter is null-safe), so the failure mode is
// not a crash but a preference that never persists, which is exactly what a
// test would want to assert on. An in-memory shim restores real behaviour.
if (!globalThis.localStorage) {
  const store = new Map<string, string>();

  globalThis.localStorage = {
    get length() {
      return store.size;
    },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
  };
}

// jsdom does not implement `matchMedia` at all — reading it throws
// "matchMedia is not a function". Commit 4's theme atom subscribes to OS
// theme changes via `matchMedia("(prefers-color-scheme: dark)").addEventListener(...)`,
// so tests need a stand-in. It supports both the modern
// `addEventListener`/`removeEventListener` and the legacy
// `addListener`/`removeListener` because that's the pair a theme atom has to
// call to work across browsers, and a test double that only implements one
// would let a real bug (using the wrong one) pass silently. `matches` and
// `addListener` no-op appropriately for tests that don't otherwise touch
// theme; defaulting `matches: false` means "prefers light", an arbitrary but
// deterministic choice.
if (!globalThis.matchMedia) {
  globalThis.matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();

    const mql: MediaQueryList = {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => void listeners.add(listener as (event: MediaQueryListEvent) => void),
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => void listeners.delete(listener as (event: MediaQueryListEvent) => void),
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

    return mql;
  };
}

// `globals: false` in vitest.config.ts means Testing Library's own auto
// cleanup (which hooks the global `afterEach`) never registers, so unmounting
// between tests has to be wired up explicitly. Without it, every render stays
// in the document and queries like `getByRole` start failing with "found
// multiple elements".
afterEach(() => {
  cleanup();
});

// `atomWithStorage` atoms (feedScopeAtom today, more as the Jotai migration
// proceeds — theme, composer draft, etc.) persist to `localStorage`, and that
// storage is shared across every test in a file because the shim above never
// tears itself down on its own. `home-page.test.tsx` used to paper over this
// by clearing it in its own per-file `afterEach`, but that file is deleted as
// part of this migration, so the same reset has to live somewhere global or
// a value written by one test silently leaks into the next one that reads
// the same key.
afterEach(() => {
  globalThis.localStorage?.clear();
});
