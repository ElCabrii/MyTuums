import { createJSONStorage } from "jotai/utils";

/**
 * The storage boundary for the app's persisted atoms (`atomWithStorage`).
 *
 * Reads the platform `localStorage` global directly — a real Storage in every
 * browser, and in Node 22+ when the process was started with
 * `--localstorage-file` — instead of going through jotai's default, whose
 * getter reaches for `window.localStorage`. Importing a persisted atom under
 * plain Node (tooling, unit tests) therefore needs no `window`: when the
 * global is absent, `createJSONStorage` null-safes every operation into
 * in-memory behaviour and the atom simply doesn't persist.
 */
export function jsonStorage() {
  return createJSONStorage(() => globalThis.localStorage ?? undefined);
}
