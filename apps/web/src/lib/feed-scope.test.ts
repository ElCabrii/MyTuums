import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";

const STORAGE_KEY = "my-tuums.feed-scope";

/**
 * `feedScopeAtom` reads `getOnInit: true` off `atomWithStorage`, which reads
 * `localStorage` synchronously the moment the module is evaluated — not
 * lazily on first `get`. To prove what a fresh page load would actually see,
 * each test seeds `localStorage` and then imports a BRAND NEW copy of the
 * module via `vi.resetModules()`, mirroring a real reload rather than reusing
 * whatever `.init` value a previous test's import already froze in.
 */
async function freshFeedScopeAtom() {
  vi.resetModules();
  const mod = await import("@/lib/feed-scope");
  return mod.feedScopeAtom;
}

describe("feedScopeAtom", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("yields global when nothing is stored", async () => {
    const feedScopeAtom = await freshFeedScopeAtom();
    const store = createStore();
    expect(store.get(feedScopeAtom)).toBe("global");
  });

  it("writing following persists to localStorage and reads back", async () => {
    const feedScopeAtom = await freshFeedScopeAtom();
    const store = createStore();

    store.set(feedScopeAtom, "following");

    expect(localStorage.getItem(STORAGE_KEY)).toBe('"following"');
    expect(store.get(feedScopeAtom)).toBe("following");

    // Simulate a fresh reload reading back what was just persisted.
    const reloaded = await freshFeedScopeAtom();
    expect(createStore().get(reloaded)).toBe("following");
  });

  // localStorage is user-editable and outlives deploys, so a hand-edited or
  // stale-version value must never reach the query as a real FeedScope.
  describe("collapses an untrustworthy stored value to global", () => {
    it.each([
      ["a JSON string that isn't a valid scope", '"nonsense"'],
      ["a JSON number", "42"],
      ["JSON null", "null"],
      ["malformed JSON", "{not-json"],
    ])("%s", async (_label, raw) => {
      localStorage.setItem(STORAGE_KEY, raw);
      const feedScopeAtom = await freshFeedScopeAtom();
      expect(createStore().get(feedScopeAtom)).toBe("global");
    });
  });

  // The whole point of `getOnInit`: without it, the very first read of a
  // freshly created store yields the hardcoded default and only picks up the
  // stored value once something subscribes — a flash from global to Following
  // right after mount. Seeding storage BEFORE the module (and therefore the
  // atom) is created is what makes this assertion meaningful.
  it("getOnInit makes the very first read already reflect what was stored, before anything subscribes", async () => {
    localStorage.setItem(STORAGE_KEY, '"following"');
    const feedScopeAtom = await freshFeedScopeAtom();
    const store = createStore();

    // No store.sub — a bare first `get` on a never-before-touched store.
    expect(store.get(feedScopeAtom)).toBe("following");
  });
});
