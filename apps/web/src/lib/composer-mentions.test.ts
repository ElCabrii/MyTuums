import { describe, expect, it } from "vitest";
import { insertMention, mentionAtCaret } from "@/lib/composer-mentions";

describe("mentionAtCaret", () => {
  it("finds a prefix at the caret and includes the token suffix", () => {
    expect(mentionAtCaret("hello @alworld!", 9)).toEqual({
      start: 6,
      end: 14,
      query: "al",
    });
  });

  it("does not treat an email or word-adjacent marker as a mention", () => {
    expect(mentionAtCaret("mail@example", 13)).toBeNull();
    expect(mentionAtCaret("word@ali", 8)).toBeNull();
    expect(mentionAtCaret("@@ali", 5)).toBeNull();
    expect(mentionAtCaret("𝒜@ali", 6)).toBeNull();
    expect(mentionAtCaret("@aliceé", 6)).toBeNull();
    expect(mentionAtCaret("@", 1)).toBeNull();
  });

  it("allows a caret inside a handle but rejects a selected range", () => {
    expect(mentionAtCaret("@alice", 3)).toEqual({ start: 0, end: 6, query: "al" });
    expect(mentionAtCaret("@alice", 0, 2)).toBeNull();
  });
});

describe("insertMention", () => {
  it("replaces the active token, including a suffix, and returns the new caret", () => {
    const token = mentionAtCaret("before @alworld after", 10);
    expect(token).not.toBeNull();

    expect(insertMention("before @alworld after", token!, "alice")).toEqual({
      value: "before @alice after",
      caret: 13,
    });
  });
});
