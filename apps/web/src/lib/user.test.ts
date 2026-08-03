import { describe, expect, it } from "vitest";
import { handleOf, initialsOf } from "@/lib/user";

describe("handleOf", () => {
  it("prefers the normalised username, falls back to displayUsername, else null", () => {
    const cases = [
      // Links stay stable across casing because the normalised column wins.
      [{ username: "alexmercer", displayUsername: "AlexMercer" }, "alexmercer"],
      [{ username: null, displayUsername: "AlexMercer" }, "AlexMercer"],
      [{ displayUsername: "AlexMercer" }, "AlexMercer"],
      [null, null],
      [undefined, null],
      [{}, null],
    ] as const;

    expect(cases.map(([user]) => handleOf(user))).toEqual(cases.map(([, expected]) => expected));
  });
});

describe("initialsOf", () => {
  it("takes up to two uppercased initials, and falls back to U", () => {
    const cases = [
      ["alex mercer", "AM"],
      ["alex", "A"],
      // Capped at two, however many words there are.
      ["alex jordan mercer", "AJ"],
      // Extra whitespace between and around words collapses.
      ["  alex    mercer  ", "AM"],
      [null, "U"],
      [undefined, "U"],
      ["", "U"],
      ["   ", "U"],
    ] as const;

    expect(cases.map(([name]) => [name, initialsOf(name)])).toEqual(
      cases.map(([name, expected]) => [name, expected]),
    );
  });
});
