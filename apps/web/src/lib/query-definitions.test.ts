import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST_PAGE_SIZE, SEARCH_PAGE_SIZE } from "@my-tuums/api/constants";
import {
  postListQueryOptions,
  replyContinuationQueryOptions,
  searchPostsQueryOptions,
  threadQueryOptions,
} from "@/lib/query-definitions";
import { setLocale } from "@/paraglide/runtime.js";

describe("post translation query inputs", () => {
  beforeEach(async () => {
    await setLocale("fr", { reload: false });
  });

  afterEach(async () => {
    await setLocale("en", { reload: false });
  });

  it("keys every post-reading query by the current translation target", () => {
    expect(postListQueryOptions({ feed: "global" }).queryKey).toEqual([
      ["post", "list"],
      { input: { limit: POST_PAGE_SIZE, targetLocale: "fr" }, type: "infinite" },
    ]);
    expect(replyContinuationQueryOptions("post-1", "cursor-1").queryKey).toEqual([
      ["post", "list"],
      {
        input: {
          limit: POST_PAGE_SIZE,
          continuationRootId: "post-1",
          targetLocale: "fr",
          cursor: "cursor-1",
        },
        type: "infinite",
      },
    ]);
    expect(threadQueryOptions("post-1").queryKey).toEqual([
      ["post", "thread"],
      { input: { postId: "post-1", targetLocale: "fr" }, type: "query" },
    ]);
  });

  it("keeps post search on original authored text", () => {
    expect(searchPostsQueryOptions(" hello ").queryKey).toEqual([
      ["search", "posts"],
      { input: { q: "hello", limit: SEARCH_PAGE_SIZE }, type: "infinite" },
    ]);
  });
});
