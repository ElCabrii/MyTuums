import { describe, expect, it } from "vitest";
import { handleOf, initialsOf } from "./user";

describe("handleOf", () => {
  it("prefers the normalised username over the display one", () => {
    expect(handleOf({ username: "alexmercer", displayUsername: "AlexMercer" })).toBe("alexmercer");
  });

  it("falls back to displayUsername when there is no canonical username", () => {
    expect(handleOf({ username: null, displayUsername: "AlexMercer" })).toBe("AlexMercer");
  });

  it("returns null when the user has no handle at all", () => {
    expect(handleOf({ username: null, displayUsername: null })).toBeNull();
    expect(handleOf(null)).toBeNull();
    expect(handleOf(undefined)).toBeNull();
  });
});

describe("initialsOf", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsOf("Alex Mercer")).toBe("AM");
  });

  it("stops at two initials however many words there are", () => {
    expect(initialsOf("Alex Von Der Mercer")).toBe("AV");
  });

  it("handles a single word", () => {
    expect(initialsOf("Alex")).toBe("A");
  });

  it("ignores runs of whitespace rather than emitting blanks", () => {
    expect(initialsOf("  Alex   Mercer  ")).toBe("AM");
  });

  it("falls back to U for a missing or empty name", () => {
    expect(initialsOf(null)).toBe("U");
    expect(initialsOf(undefined)).toBe("U");
    expect(initialsOf("")).toBe("U");
    expect(initialsOf("   ")).toBe("U");
  });
});
