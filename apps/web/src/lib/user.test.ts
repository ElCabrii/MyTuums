import { describe, expect, it } from "vitest";
import { handleOf, initialsOf } from "@/lib/user";

describe("handleOf", () => {
  it("prefers the normalised username over displayUsername so links stay stable across casing", () => {
    expect(handleOf({ username: "alexmercer", displayUsername: "AlexMercer" })).toBe(
      "alexmercer",
    );
  });

  it("falls back to displayUsername when username is absent", () => {
    expect(handleOf({ username: null, displayUsername: "AlexMercer" })).toBe("AlexMercer");
    expect(handleOf({ displayUsername: "AlexMercer" })).toBe("AlexMercer");
  });

  it("returns null for null/undefined/empty user", () => {
    expect(handleOf(null)).toBeNull();
    expect(handleOf(undefined)).toBeNull();
    expect(handleOf({})).toBeNull();
  });
});

describe("initialsOf", () => {
  it("returns two uppercased initials for two words", () => {
    expect(initialsOf("alex mercer")).toBe("AM");
  });

  it("returns one initial for a single word", () => {
    expect(initialsOf("alex")).toBe("A");
  });

  it("caps at two initials for more than two words", () => {
    expect(initialsOf("alex jordan mercer")).toBe("AJ");
  });

  it("collapses extra whitespace between words", () => {
    expect(initialsOf("  alex    mercer  ")).toBe("AM");
  });

  it("returns U for null/undefined/empty", () => {
    expect(initialsOf(null)).toBe("U");
    expect(initialsOf(undefined)).toBe("U");
    expect(initialsOf("")).toBe("U");
  });

  it("returns U for a name of only whitespace", () => {
    expect(initialsOf("   ")).toBe("U");
  });
});
