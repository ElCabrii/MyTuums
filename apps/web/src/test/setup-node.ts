import { installTestAuthFixture } from "./auth-fixture";

/**
 * Setup for the `node` Vitest project ("*.test.ts" under src/): tests of pure
 * client logic with no document. It provides only the BetterAuth fixture — no
 * Testing Library, no jest-dom, and no browser global at all: no `window`, no
 * `document`, no `matchMedia`, no `localStorage`. A node test that reaches for
 * one should fail, because that failure is the architecture telling the test
 * it belongs in the `dom` project.
 *
 * Persisted atoms need no storage merely to be imported or used —
 * `src/lib/json-storage.ts` null-safes an absent `localStorage` into
 * in-memory behaviour. A test that asserts persistence installs its own
 * in-memory storage explicitly, via `installInMemoryStorage()` from
 * `src/test/memory-storage.ts`.
 */
installTestAuthFixture();
