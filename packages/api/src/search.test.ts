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

  it("escapes a mixed query end to end", () => {
    expect(escapeLikePattern("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});
