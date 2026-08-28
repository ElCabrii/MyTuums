import { afterEach } from "vitest";
import { installTestAuthFixture } from "./auth-fixture";
import { createInMemoryStorage } from "./memory-storage";

/**
 * Setup for the `dom` Vitest project ("*.test.tsx" plus the "*.dom.test.ts"
 * `*.dom.test.ts` exceptions): everything that renders React or asserts on
 * the real document. Each shim below names the tests that fail without it —
 * when the tests it serves go away, so does the shim.
 */
installTestAuthFixture();

/**
 * Node >= 22 ships its own `localStorage` global, which is `undefined` unless
 * the process was started with `--localstorage-file`. Under jsdom `window`
 * *is* `globalThis`, so that undefined global shadows the working
 * implementation jsdom provides, and anything reading `localStorage` —
 * `feedScopeAtom`, `composerDraftAtom`, `themeAtom` — silently gets nothing.
 *
 * Jotai swallows it (its storage getter is null-safe), so the failure mode is
 * not a crash but a preference that never persists: exactly the behaviour
 * several tests here exist to assert on. An in-memory implementation from
 * `./memory-storage` restores it.
 */
if (!globalThis.localStorage) {
  globalThis.localStorage = createInMemoryStorage();
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
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (listener instanceof Function) listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (listener instanceof Function) listeners.delete(listener);
      },
      addListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
        if (listener) listeners.add(listener);
      },
      removeListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
        if (listener) listeners.delete(listener);
      },
      dispatchEvent: (event: Event) => {
        // SAFETY: every listener was added through the addEventListener above,
        // so each accepts the MediaQueryListEvent shape dispatched here.
        listeners.forEach((listener) => listener(event as MediaQueryListEvent));
        return true;
      },
    };
  };
}

/**
 * Rendered components need jest-dom's matchers and RTL's `cleanup` between
 * tests; nothing in this project runs without them.
 */
await import("@testing-library/jest-dom/vitest");
const { cleanup } = await import("@testing-library/react");
afterEach(() => cleanup());

/**
 * The `localStorage` shim above has no per-test lifetime of its own, so a
 * value written by one test is still there for the next one that reads the
 * same key. Persisted atoms (`feedScopeAtom`, `composerDraftAtom`, the theme)
 * are the ones this bites.
 */
afterEach(() => {
  globalThis.localStorage?.clear();
});
