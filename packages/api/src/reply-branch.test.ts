import { describe, expect, it } from "vitest";
import { selectReplyBranch, type ReplyBranchNode } from "./reply-branch.js";

const at = (seconds: number) => new Date(`2026-01-01T00:00:${String(seconds).padStart(2, "0")}Z`);

function node(id: string, parentId: string, authorId: string, seconds: number): ReplyBranchNode {
  return { id, parentId, authorId, createdAt: at(seconds) };
}

describe("selectReplyBranch", () => {
  it("includes the path to the focused author's first reply and later posts in that branch", () => {
    const descendants = [
      node("participant-step", "direct", "participant", 1),
      node("author-joins", "participant-step", "focused-author", 2),
      node("later-participant", "author-joins", "participant", 3),
    ];

    expect(
      selectReplyBranch("direct", "focused-author", descendants).map((post) => post.id),
    ).toEqual(["participant-step", "author-joins", "later-participant"]);
  });

  it("does not expand a descendant tree the focused author never joins", () => {
    const descendants = [
      node("participant-one", "direct", "participant", 1),
      node("participant-two", "participant-one", "another-participant", 2),
    ];

    expect(selectReplyBranch("direct", "focused-author", descendants)).toEqual([]);
  });

  it("chooses the earliest author-involving branch and then the earliest child at each fork", () => {
    const descendants = [
      node("later-path", "direct", "participant", 2),
      node("later-author-reply", "later-path", "focused-author", 4),
      node("chosen-path", "direct", "participant", 1),
      node("chosen-author-reply", "chosen-path", "focused-author", 3),
      node("later-child", "chosen-author-reply", "participant", 6),
      node("chosen-child", "chosen-author-reply", "participant", 5),
    ];

    expect(
      selectReplyBranch("direct", "focused-author", descendants).map((post) => post.id),
    ).toEqual(["chosen-path", "chosen-author-reply", "chosen-child"]);
  });
});
