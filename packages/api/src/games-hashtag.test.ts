import { describe, expect, it } from "vitest";
import {
  assignHashtagKeys,
  bareHashtagKey,
  HashtagAssignmentError,
  type HashtagCandidate,
} from "./games-hashtag.js";

// Each test pins one clause of issue #314's Q15: keys are the lowercased name
// with `[^a-z0-9]` stripped, collisions take a release-year suffix except the
// lowest-IGDB-id holder of the bare key, existing assignments are sticky, and
// any name that cannot receive a unique key fails the whole assignment
// (fail-closed, Q28) rather than shipping a row no hashtag can ever resolve
// to.

describe("bareHashtagKey", () => {
  it("lowercases and strips everything non-alphanumeric, digits untouched", () => {
    expect(bareHashtagKey("FINAL FANTASY VII")).toBe("finalfantasyvii");
    expect(bareHashtagKey("Baldur's Gate 3")).toBe("baldursgate3");
    expect(bareHashtagKey("DOOM")).toBe("doom");
  });
});

describe("assignHashtagKeys", () => {
  const doomPair: HashtagCandidate[] = [
    { igdbId: 20, name: "DOOM", firstReleaseYear: 2016 },
    { igdbId: 10, name: "Doom", firstReleaseYear: 1993 },
  ];

  it("gives the bare key to the lowest IGDB id and year-suffixes the other collider", () => {
    expect(assignHashtagKeys(doomPair, new Set())).toEqual(
      new Map([
        [10, "doom"],
        [20, "doom2016"],
      ]),
    );
  });

  it("produces the same assignments whatever order the candidates arrive in", () => {
    const forward = assignHashtagKeys(doomPair, new Set());
    const backward = assignHashtagKeys([...doomPair].reverse(), new Set());
    expect(forward).toEqual(backward);
  });

  it("never displaces an incumbent key — the sticky rule is the occupied set", () => {
    // The 1993 incumbent holds `doom`; a later-synced 2016 game with a LOWER
    // id must still not steal it (Q29's "assignments stay permanently
    // stable" is exactly this case).
    const assignments = assignHashtagKeys(
      [{ igdbId: 5, name: "Doom", firstReleaseYear: 2016 }],
      new Set(["doom"]),
    );
    expect(assignments.get(5)).toBe("doom2016");
  });

  it("returns no assignment for games whose keys are already held (they are not candidates)", () => {
    expect(assignHashtagKeys([], new Set(["doom"]))).toEqual(new Map());
  });

  it("falls back to the IGDB id when the year is missing, and year+id when both shorter rungs are taken", () => {
    const missingYear = assignHashtagKeys(
      [{ igdbId: 7, name: "P.T.", firstReleaseYear: null }],
      new Set(["pt"]),
    );
    expect(missingYear.get(7)).toBe("pt7");

    // An unrelated game actually named "Rugby 2000" holds the year rung; the
    // final rung embeds the unique id and terminates the ladder.
    const exhaustedRungs = assignHashtagKeys(
      [{ igdbId: 5, name: "Rugby", firstReleaseYear: 2000 }],
      new Set(["rugby", "rugby2000"]),
    );
    expect(exhaustedRungs.get(5)).toBe("rugby20005");
  });

  it("fails the whole assignment when a name strips to the empty key", () => {
    expect(() =>
      assignHashtagKeys(
        [
          { igdbId: 1, name: "Fine", firstReleaseYear: 2020 },
          { igdbId: 2, name: "『・』", firstReleaseYear: 2020 },
        ],
        new Set(),
      ),
    ).toThrow(HashtagAssignmentError);
  });

  it("fails the whole assignment when every fallback spelling is taken", () => {
    expect(() =>
      assignHashtagKeys(
        [{ igdbId: 7, name: "P.T.", firstReleaseYear: null }],
        new Set(["pt", "pt7"]),
      ),
    ).toThrow(/every fallback key taken/);
  });
});
