import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// `globals: false` in vitest.config.ts means Testing Library's own auto
// cleanup (which hooks the global `afterEach`) never registers, so unmounting
// between tests has to be wired up explicitly. Without it, every render stays
// in the document and queries like `getByRole` start failing with "found
// multiple elements".
afterEach(() => {
  cleanup();
});

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
