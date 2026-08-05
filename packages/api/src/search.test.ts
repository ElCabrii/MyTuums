import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "./search.js";

describe("escapeLikePattern", () => {
  it("escapes % so a query like 100% can't match every post that contains 100", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
  });

  it("escapes _ so it can't act as the single-character wildcard", () => {
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
  });

  it("escapes \\ — LIKE's own escape character — before anything else", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("leaves plain text untouched", () => {
    expect(escapeLikePattern("hello world")).toBe("hello world");
  });

  it("leaves multi-byte text untouched", () => {
    expect(escapeLikePattern("héllo wörld — 你好, café")).toBe("héllo wörld — 你好, café");
  });

  it("does not double-escape a backslash that already precedes a wildcard", () => {
    // The input is one literal backslash then one literal percent. The output
    // must contain exactly three backslashes before the percent — one to
    // escape the backslash itself and two to escape the percent — so LIKE
    // reads the pair as two literals. Four backslashes would mean the percent
    // was escaped by a backslash that was itself escaped: wrong.
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });

  it("escapes a mixed query end to end", () => {
    expect(escapeLikePattern("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});
