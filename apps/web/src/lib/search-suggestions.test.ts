import { describe, expect, it } from "vitest";
import type { SearchTypeahead, SearchUser } from "@/lib/orpc";
import { nextHighlight, suggestionRows } from "@/lib/search-suggestions";

function makeUser(overrides: Partial<SearchUser> & { id: string }): SearchUser {
  return {
    name: "User",
    username: "user",
    displayUsername: "User",
    image: null,
    bio: null,
    bannerImage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    viewerIsFollowing: false,
    ...overrides,
  };
}

function typeahead(users: SearchUser[]): SearchTypeahead {
  return { users };
}

describe("suggestionRows", () => {
  // `undefined` is what the dropdown sees while the typeahead query is
  // pending, disabled, or errored — never a placeholder row.
  it("returns [] for an undefined payload", () => {
    expect(suggestionRows(undefined)).toEqual([]);
  });

  // An empty payload is the API's "no matches" answer; the dropdown swaps in
  // its no-results line, so a bare see-all row would be a lie.
  it("returns [] for an empty payload", () => {
    expect(suggestionRows(typeahead([]))).toEqual([]);
  });

  it("orders profile rows before the terminal see-all row", () => {
    const alice = makeUser({ id: "u-alice", username: "alice" });
    const bob = makeUser({ id: "u-bob", username: "bob" });

    const rows = suggestionRows(typeahead([alice, bob]));

    expect(rows).toEqual([
      { kind: "user", user: alice },
      { kind: "user", user: bob },
      { kind: "see-all" },
    ]);
  });

  it("ends with the see-all row when a profile matches", () => {
    const alice = makeUser({ id: "u-alice" });

    expect(suggestionRows(typeahead([alice]))).toEqual([
      { kind: "user", user: alice },
      { kind: "see-all" },
    ]);
  });
});

describe("nextHighlight", () => {
  // current, delta, length, expected — the table is the whole contract:
  // both ends wrap and an initial arrow picks the corresponding edge.
  it.each([
    [-1, 1, 3, 0], // ArrowDown from "nothing" lands on the first row
    [2, 1, 3, 0], // ArrowDown on the last row wraps to the first
    [0, -1, 3, 2], // ArrowUp on the first row wraps to the last
    [-1, -1, 3, 2], // ArrowUp from "nothing" starts at the last row
    [0, 1, 3, 1], // moving through the middle
    [1, 1, 3, 2],
    [2, -1, 3, 1],
  ])("nextHighlight(%i, %i, %i) -> %i", (current, delta, length, expected) => {
    expect(nextHighlight(current, delta, length)).toBe(expected);
  });

  it("stays at -1 for an empty row list", () => {
    expect(nextHighlight(-1, 1, 0)).toBe(-1);
    expect(nextHighlight(0, -1, 0)).toBe(-1);
  });
});
