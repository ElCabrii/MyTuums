import { afterEach } from "vitest";

/**
 * An in-memory `Storage` implementation for tests.
 *
 * The node project deliberately provides no global `localStorage` — the
 * production boundary in `src/lib/json-storage.ts` degrades to in-memory
 * behaviour without one, so only a test that actually asserts persistence
 * semantics (a write landing in storage, a hand-edited value being sanitised,
 * or — negatively — nothing being written) needs an implementation, and it
 * installs its own.
 */
export function createInMemoryStorage(): Storage {
  const entries = new Map<string, string>();

  return {
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
 * For a test file that reads or writes persisted state: install the in-memory
 * storage and clear it between tests, so persisted state never leaks from one
 * test into the next. The dom setup instead assigns `createInMemoryStorage()`
 * directly, because there it is environment repair (Node 22's `undefined`
 * global shadowing jsdom's working implementation), not a per-test concern.
 */
export function installInMemoryStorage(): void {
  globalThis.localStorage = createInMemoryStorage();

  afterEach(() => {
    globalThis.localStorage?.clear();
  });
}
