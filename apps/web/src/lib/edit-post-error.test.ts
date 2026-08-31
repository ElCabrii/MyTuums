import { describe, expect, it } from "vitest";
import { localizeEditPostError } from "@/lib/edit-post-error";
import { m } from "@/paraglide/messages.js";

describe("localizeEditPostError", () => {
  // Each English literal is shared byte-for-byte with a refusal `post.edit`
  // throws (packages/api/src/posts.ts); the dialog is the only surface that
  // shows one, and only through this mapping. The empty-content refusal is
  // `post.create`'s cross-field rule, which `post.edit` re-checks against the
  // row's own attachments.
  const knownMessages: [string, () => string][] = [
    ["This post was removed by a moderator and can no longer be edited.", m.post_edit_removed],
    ["This post was deleted and can no longer be edited.", m.post_edit_deleted],
    ["Post cannot be empty.", m.post_cannot_be_empty],
  ];

  it.each(knownMessages)("translates %s", (raw, expected) => {
    expect(localizeEditPostError(raw)).toBe(expected());
  });

  // A server error that is not one of `post.edit`'s mapped refusals must
  // reach the user verbatim, not disappear into a generic fallback — the same
  // fallthrough contract `localizeAuthError` keeps. "Post not found." is one
  // of `post.edit`'s deliberately unmapped refusals (unreachable through the
  // dialog), so it exercises the same path.
  it("passes an unrecognised string through verbatim", () => {
    expect(localizeEditPostError("Post not found.")).toBe("Post not found.");
  });

  it("passes an empty string through verbatim", () => {
    expect(localizeEditPostError("")).toBe("");
  });
});
