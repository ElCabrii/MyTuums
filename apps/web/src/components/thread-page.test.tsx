import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ORPCError } from "@orpc/client";
import { THREAD_ANCESTOR_MAX } from "@my-tuums/api/constants";
import {
  createTestQueryClient,
  makePost,
  makeThread,
  queryFixtures,
  renderWithProviders,
} from "@/test/render";
import { ThreadPage } from "@/components/thread-page";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = {
  post: {
    thread: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    like: vi.fn(),
    unlike: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
  document.head.querySelector('meta[name="description"]')?.remove();
  const description = document.createElement("meta");
  description.setAttribute("name", "description");
  document.head.appendChild(description);
});

describe("ThreadPage query states", () => {
  it("renders a loading shell while the focused thread is pending", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).thread.loading("pending-post");

    await renderWithProviders(<ThreadPage />, {
      queryClient,
      initialPath: "/post/pending-post",
      signedInAs: true,
    });

    expect(screen.queryByRole("heading", { name: m.post_title() })).not.toBeInTheDocument();
    expect(fakeClient.post.thread).not.toHaveBeenCalled();
  });

  it.each(["BAD_REQUEST", "NOT_FOUND"] as const)(
    "renders the unavailable card without a retry action for %s",
    async (code) => {
      const queryClient = createTestQueryClient();
      await queryFixtures(queryClient).thread.error("missing-post", new ORPCError(code));

      await renderWithProviders(<ThreadPage />, {
        queryClient,
        initialPath: "/post/missing-post",
        signedInAs: true,
      });

      expect(screen.getByRole("heading", { name: m.post_not_found() })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: m.common_back_to_home() })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: m.common_try_again() })).not.toBeInTheDocument();
    },
  );

  it("retries a transient error and renders the recovered thread", async () => {
    const post = makePost({ id: "network-post", content: "Recovered thread", replyCount: 0 });
    const recovered = makeThread({ post });
    fakeClient.post.thread.mockResolvedValue(recovered);
    const queryClient = createTestQueryClient();
    await queryFixtures(queryClient).thread.error("network-post", new Error("network unavailable"));
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null }], {
      feed: "global",
      parentId: post.id,
    });
    await renderWithProviders(<ThreadPage />, {
      queryClient,
      initialPath: "/post/network-post",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.common_try_again() }));

    expect(await screen.findByText("Recovered thread")).toBeInTheDocument();
    await waitFor(() =>
      expect(fakeClient.post.thread).toHaveBeenCalledWith(
        { postId: "network-post" },
        expect.anything(),
      ),
    );
  });
});

describe("ThreadPage successful rendering", () => {
  it("uses the focused post for the document title and description", async () => {
    const content = "A focused post with a useful preview.";
    const focused = makePost({ id: "head-post", content });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).thread.data(focused.id, makeThread({ post: focused }));
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null }], {
      feed: "global",
      parentId: focused.id,
    });

    await renderWithProviders(<ThreadPage />, {
      queryClient,
      initialPath: `/post/${focused.id}`,
      signedInAs: true,
    });

    await waitFor(() => {
      expect(document.title).toBe(`${content} - ${m.app_title_suffix()}`);
      expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute(
        "content",
        content,
      );
    });
  });

  it("renders the ancestor chain, truncation notice, focused post, composer and reply feed", async () => {
    const ancestorA = makePost({ id: "ancestor-a", content: "Oldest ancestor" });
    const ancestorB = makePost({ id: "ancestor-b", content: "Nearest ancestor" });
    const focused = makePost({
      id: "focused-post",
      content: "Focused body",
      replyCount: 2,
    });
    const reply = makePost({ id: "reply-1", parentId: focused.id, content: "A direct reply" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).thread.data(
      focused.id,
      makeThread({ post: focused, ancestors: [ancestorA, ancestorB], truncated: true }),
    );
    queryFixtures(queryClient).postList.data([{ items: [reply], nextCursor: null }], {
      feed: "global",
      parentId: focused.id,
    });

    await renderWithProviders(<ThreadPage />, {
      queryClient,
      initialPath: `/post/${focused.id}`,
      signedInAs: true,
    });

    expect(screen.getByText("Oldest ancestor")).toBeInTheDocument();
    expect(screen.getByText("Nearest ancestor")).toBeInTheDocument();
    expect(
      screen.getByText(m.thread_truncated({ count: String(THREAD_ANCESTOR_MAX) })),
    ).toBeInTheDocument();
    expect(screen.getByText("Focused body")).toBeInTheDocument();
    expect(screen.getByText(m.reply_count_many({ count: "2" }))).toBeInTheDocument();
    expect(screen.getByText("A direct reply")).toBeInTheDocument();
  });

  it("uses the singular reply label for exactly one reply", async () => {
    const focused = makePost({ id: "single-reply-post", replyCount: 1 });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).thread.data(focused.id, makeThread({ post: focused }));
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null }], {
      feed: "global",
      parentId: focused.id,
    });

    await renderWithProviders(<ThreadPage />, {
      queryClient,
      initialPath: `/post/${focused.id}`,
      signedInAs: true,
    });

    expect(screen.getByText(m.reply_count_one({ count: "1" }))).toBeInTheDocument();
  });

  it("renders the focused author's continuation inline beneath its direct reply", async () => {
    const focusedAuthor = { id: "author-a", name: "Author A" };
    const focused = makePost({
      id: "focused-conversation",
      content: "A starts",
      author: { ...makePost().author, ...focusedAuthor },
      replyCount: 2,
    });
    const directReply = makePost({
      id: "direct-b",
      parentId: focused.id,
      content: "B replies",
    });
    const authorReply = makePost({
      id: "author-a-reply",
      parentId: directReply.id,
      content: "A answers",
      author: focused.author,
    });
    const continuation = makePost({
      id: "continuation-c",
      parentId: authorReply.id,
      content: "C continues",
    });
    const unrelatedDirectReply = makePost({
      id: "unrelated-direct",
      parentId: focused.id,
      content: "Unrelated direct reply",
    });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).thread.data(focused.id, makeThread({ post: focused }));
    queryFixtures(queryClient).postList.data(
      [
        {
          items: [directReply, unrelatedDirectReply],
          nextCursor: null,
          continuations: [
            {
              rootPostId: directReply.id,
              items: [authorReply, continuation],
              nextCursor: null,
            },
          ],
        },
      ],
      { feed: "global", parentId: focused.id },
    );

    await renderWithProviders(<ThreadPage />, {
      queryClient,
      initialPath: `/post/${focused.id}`,
      signedInAs: true,
    });

    expect(screen.getByText("B replies")).toBeInTheDocument();
    expect(screen.getByText("A answers")).toBeInTheDocument();
    expect(screen.getByText("C continues")).toBeInTheDocument();
    expect(screen.getByText("Unrelated direct reply")).toBeInTheDocument();
  });

  it("loads a capped continuation in place from one accessible show-more action", async () => {
    const focused = makePost({ id: "capped-focused", replyCount: 1 });
    const directReply = makePost({ id: "capped-direct", parentId: focused.id });
    const embedded = makePost({ id: "embedded-reply", parentId: directReply.id });
    const loaded = makePost({
      id: "loaded-reply",
      parentId: embedded.id,
      content: "Loaded in place",
    });
    fakeClient.post.list.mockResolvedValue({ items: [loaded], nextCursor: null });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).thread.data(focused.id, makeThread({ post: focused }));
    queryFixtures(queryClient).postList.data(
      [
        {
          items: [directReply],
          nextCursor: null,
          continuations: [
            {
              rootPostId: directReply.id,
              items: [embedded],
              nextCursor: "branch-cursor",
            },
          ],
        },
      ],
      { feed: "global", parentId: focused.id },
    );

    await renderWithProviders(<ThreadPage />, {
      queryClient,
      initialPath: `/post/${focused.id}`,
      signedInAs: true,
    });

    const user = userEvent.setup();
    const showMore = screen.getByRole("button", { name: m.thread_show_more_replies() });
    expect(screen.getAllByRole("button", { name: m.thread_show_more_replies() })).toHaveLength(1);
    await user.click(showMore);

    expect(await screen.findByText("Loaded in place")).toBeInTheDocument();
    await waitFor(() =>
      expect(fakeClient.post.list).toHaveBeenCalledWith(
        {
          limit: 20,
          continuationRootId: directReply.id,
          cursor: "branch-cursor",
        },
        expect.anything(),
      ),
    );
    expect(
      screen.queryByRole("button", { name: m.thread_show_more_replies() }),
    ).not.toBeInTheDocument();
  });
});
