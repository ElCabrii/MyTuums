import { describe, expect, it } from "vitest";
import {
  hashtagAtCaret,
  insertHashtag,
  insertMention,
  mentionAtCaret,
} from "@/lib/composer-mentions";

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

// The `#tag` half (issue #314, Q4): the same contract over the renderer's
// tag rules — completing exactly the tokens the published text would
// linkify, and writing the catalog's full key on accept.
describe("hashtagAtCaret", () => {
  it("finds a completable tag prefix and its whole token", () => {
    // Caret after `#wo` (index 10): the prefix is "wo" and the token spans
    // the whole `#wow` — accepting replaces the full word, not just the
    // typed prefix.
    expect(hashtagAtCaret("loving #wow right now", 10)).toEqual({
      start: 7,
      end: 11,
      query: "wo",
    });
  });

  it("refuses the tokens the renderer leaves as plain text", () => {
    expect(hashtagAtCaret("##tag", 5)).toBeNull(); // a lone # before it
    expect(hashtagAtCaret("word#tag", 8)).toBeNull(); // glued word
    expect(hashtagAtCaret("#", 1)).toBeNull(); // empty prefix
    expect(hashtagAtCaret("#café", 5)).toBeNull(); // accent ends the word
  });

  it("allows a caret inside a tag but rejects a selected range", () => {
    expect(hashtagAtCaret("#hades", 3)).toEqual({ start: 0, end: 6, query: "ha" });
    expect(hashtagAtCaret("#hades", 0, 2)).toBeNull();
  });
});

describe("insertHashtag", () => {
  it("replaces the typed token with the catalog's full key and lands the caret after it", () => {
    const token = hashtagAtCaret("playing #wow!", 10);
    expect(token).not.toBeNull();

    expect(insertHashtag("playing #wow!", token!, "worldofwarcraft")).toEqual({
      value: "playing #worldofwarcraft!",
      caret: 24,
    });
  });
});
