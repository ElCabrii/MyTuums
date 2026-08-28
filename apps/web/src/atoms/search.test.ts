import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = { search: { typeahead: vi.fn(), users: vi.fn(), posts: vi.fn() } };

installTestOrpc(createTanstackQueryUtils(fakeClient));

import {
  clearSearchFamilies,
  debounceMs,
  debouncedSearchQueryAtom,
  resetSearchAtomsAtom,
  searchInputAtom,
  searchPostsAtom,
  searchUsersAtom,
  setSearchQueryAtom,
  typeaheadAtom,
} from "@/atoms/search";

function freshStore() {
  const store = createStore();
  store.set(queryClientAtom, new QueryClient());
  return store;
}

describe("search input debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the input box immediately and the debounced copy only after the delay", () => {
    const store = freshStore();
    store.set(setSearchQueryAtom, "ali");

    expect(store.get(searchInputAtom)).toBe("ali");
    expect(store.get(debouncedSearchQueryAtom)).toBe("");

    vi.advanceTimersByTime(debounceMs - 1);
    expect(store.get(debouncedSearchQueryAtom)).toBe("");

    vi.advanceTimersByTime(1);
    expect(store.get(debouncedSearchQueryAtom)).toBe("ali");
  });

  it("a second keystroke supersedes the first — only the final value lands", () => {
    const store = freshStore();
    store.set(setSearchQueryAtom, "a");
    vi.advanceTimersByTime(100);
    store.set(setSearchQueryAtom, "ab");

    vi.advanceTimersByTime(debounceMs);
    expect(store.get(debouncedSearchQueryAtom)).toBe("ab");

    // The first keystroke's timer was cancelled, so it must not land late
    // with the superseded value.
    vi.advanceTimersByTime(debounceMs);
    expect(store.get(debouncedSearchQueryAtom)).toBe("ab");
  });

  it("trims the query before it reaches the request atoms", () => {
    const store = freshStore();
    store.set(setSearchQueryAtom, "  alice  ");

    vi.advanceTimersByTime(debounceMs);

    expect(store.get(searchInputAtom)).toBe("  alice  ");
    expect(store.get(debouncedSearchQueryAtom)).toBe("alice");
  });

  it("turns whitespace-only input into an empty, disabled query", () => {
    const store = freshStore();
    store.set(setSearchQueryAtom, "   \t");

    vi.advanceTimersByTime(debounceMs);

    expect(store.get(debouncedSearchQueryAtom)).toBe("");
  });

  it("resetSearchAtomsAtom clears a pending timer and both values", () => {
    const store = freshStore();
    store.set(setSearchQueryAtom, "a");
    vi.advanceTimersByTime(100);

    store.set(resetSearchAtomsAtom);

    expect(store.get(searchInputAtom)).toBe("");
    expect(store.get(debouncedSearchQueryAtom)).toBe("");

    // The cancelled timer must never land the value it was carrying.
    vi.advanceTimersByTime(1000);
    expect(store.get(debouncedSearchQueryAtom)).toBe("");
  });
});

describe("typeaheadAtom", () => {
  beforeEach(() => {
    fakeClient.search.typeahead.mockReset();
    // Self-contained regardless of test order — the debounce describe above
    // leaves fake timers behind until its own afterEach runs.
    vi.useRealTimers();
  });

  it("stays idle for an empty query — no request ever leaves", () => {
    const store = freshStore();
    const unsub = store.sub(typeaheadAtom, () => {});

    expect(fakeClient.search.typeahead).not.toHaveBeenCalled();
    expect(store.get(typeaheadAtom).isPending).toBe(true);
    expect(store.get(typeaheadAtom).fetchStatus).toBe("idle");

    unsub();
  });

  it("fires once the debounced query lands — the gate is not a total disable", async () => {
    const store = freshStore();
    const unsub = store.sub(typeaheadAtom, () => {});

    store.set(setSearchQueryAtom, "alice");
    expect(fakeClient.search.typeahead).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(fakeClient.search.typeahead).toHaveBeenCalledWith({ q: "alice" }, expect.anything());
    });

    unsub();
  });
});

describe("clearSearchFamilies", () => {
  it("empties both families — the same query produces brand new atoms afterwards", () => {
    const usersBefore = searchUsersAtom("x");
    const postsBefore = searchPostsAtom("x");

    clearSearchFamilies();

    expect(searchUsersAtom("x")).not.toBe(usersBefore);
    expect(searchPostsAtom("x")).not.toBe(postsBefore);
  });

  it("canonicalizes equivalent queries to the same family atoms", () => {
    expect(searchUsersAtom(" alice ")).toBe(searchUsersAtom("alice"));
    expect(searchPostsAtom(" alice ")).toBe(searchPostsAtom("alice"));
  });
});
