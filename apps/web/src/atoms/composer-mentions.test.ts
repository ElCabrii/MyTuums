import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { clearComposerMentionFamilies, composerMentionAtomFamily } from "@/atoms/composer-mentions";

describe("composerMentionAtomFamily", () => {
  it("keeps post and reply completion state independent", () => {
    const store = createStore();
    const token = { start: 0, end: 3, query: "al" };

    store.set(composerMentionAtomFamily("post"), { token, highlight: 1, open: true });

    expect(store.get(composerMentionAtomFamily("post"))).toEqual({
      token,
      highlight: 1,
      open: true,
    });
    expect(store.get(composerMentionAtomFamily("reply:parent-1"))).toEqual({
      token: null,
      highlight: -1,
      open: false,
    });
  });

  it("removes every scoped atom during viewer teardown", () => {
    const before = composerMentionAtomFamily("reply:parent-2");
    clearComposerMentionFamilies();

    expect(composerMentionAtomFamily("reply:parent-2")).not.toBe(before);
  });
});
