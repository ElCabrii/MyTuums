import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { createStore } from "jotai";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { renderWithProviders, makeAuthor, makePost } from "@/test/render";
import { installTestOrpc, orpc } from "@/lib/orpc";
import { deletePostDialogAtom } from "@/atoms/post-delete";
import { PostCard } from "@/components/post-card";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

// PostCard's like button is a write-only atom (`useSetAtom`, never
// `useAtom`) — see `atoms/like.ts`. Running the real atom against this fake
// client lets the one test that clicks like assert "the button asked the
// transport to toggle this exact post" without a network round trip jsdom
// has no server to answer.
const fakeClient = {
  post: {
    like: vi.fn(() => Promise.resolve({ postId: "", likeCount: 0, viewerHasLiked: true })),
    unlike: vi.fn(() => Promise.resolve({ postId: "", likeCount: 0, viewerHasLiked: false })),
    list: vi.fn(),
    thread: vi.fn(),
  },
  search: { users: vi.fn(), posts: vi.fn() },
  user: { byUsername: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

/** Seeds the post into the list cache, which is where the like atom reads the current state from. */
function seedPostCache(queryClient: QueryClient, post: ReturnType<typeof makePost>): void {
  queryClient.setQueryData(orpc.post.list.key({ input: { limit: 20 } }), {
    pages: [{ items: [post], nextCursor: null }],
    pageParams: [undefined],
  });
}

describe("PostCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("signed in", () => {
    it("renders the like control as a pressed toggle when already liked, and invokes the toggle on click", async () => {
      const post = makePost({ viewerHasLiked: true, likeCount: 3 });
      const queryClient = new QueryClient();
      seedPostCache(queryClient, post);
      await renderWithProviders(<PostCard post={post} />, { queryClient, signedInAs: true });

      const likeButton = screen.getByRole("button", { name: m.post_unlike({ count: "3" }) });
      expect(likeButton).toHaveAttribute("aria-pressed", "true");

      const user = userEvent.setup();
      await user.click(likeButton);

      await waitFor(() =>
        expect(fakeClient.post.unlike).toHaveBeenCalledWith({ postId: post.id }, expect.anything()),
      );
    });

    it("renders the like control as an unpressed toggle when not liked", async () => {
      const post = makePost({ viewerHasLiked: false });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      const likeButton = screen.getByRole("button", {
        name: m.post_like({ count: String(post.likeCount) }),
      });
      expect(likeButton).toHaveAttribute("aria-pressed", "false");
    });

    it("links the reply control to the post's thread, with its accessible name coming from aria-label", async () => {
      const post = makePost();
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      // The link's visible content is a bare reply count — without
      // `aria-label`, content wins over `title` for the accessible name and
      // the link would announce as a naked number. This is the case the
      // source comment on the signed-in reply link exists to prevent.
      const replyLink = screen.getByRole("link", {
        name: m.reply_to_post({ count: String(post.replyCount) }),
      });
      expect(replyLink).toHaveAttribute("href", `/post/${post.id}`);
    });
  });

  describe("variant=focused", () => {
    it("renders the timestamp as plain text and the reply count as a span, neither as a link", async () => {
      // Distinct like/reply counts so the two "N" spans aren't ambiguous to query.
      const post = makePost({ replyCount: 7, likeCount: 3 });
      await renderWithProviders(<PostCard post={post} variant="focused" />, { signedInAs: true });

      // Both would point at the page already open, so neither is a link —
      // the reply count is a <span> with no accessible name of its own.
      expect(screen.getByText("7")).toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: m.reply_to_post({ count: String(post.replyCount) }) }),
      ).not.toBeInTheDocument();
    });

    it("shows the exact creation date and time, tied to createdAt through a <time> element", async () => {
      const createdAt = new Date("2026-08-06T14:30:00Z");
      const post = makePost({ createdAt });
      await renderWithProviders(<PostCard post={post} variant="focused" />, { signedInAs: true });

      // The permalink is where the durable value belongs — a reader following
      // a link here should see when the post was written, not "2 days ago".
      const timestamp = screen.getByText(formatDateTime(createdAt, getLocale()));
      expect(timestamp.tagName).toBe("TIME");
      expect(timestamp).toHaveAttribute("datetime", createdAt.toISOString());
    });
  });

  describe("variant=feed", () => {
    it("keeps the compact relative timestamp while still exposing the ISO value", async () => {
      const createdAt = new Date(Date.now() - 5 * 60 * 1000);
      const post = makePost({ createdAt });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      const timestamp = screen.getByText(
        formatRelativeTime(createdAt, getLocale(), m.post_just_now()),
      );
      expect(timestamp.tagName).toBe("TIME");
      expect(timestamp).toHaveAttribute("datetime", createdAt.toISOString());
    });
  });

  describe("variant=ancestor", () => {
    it("renders without the feed card's border/padding treatment", async () => {
      const post = makePost();
      const feed = await renderWithProviders(<PostCard post={post} variant="feed" />);
      const ancestor = await renderWithProviders(<PostCard post={post} variant="ancestor" />);

      const feedCard = feed.container.firstElementChild;
      const ancestorCard = ancestor.container.firstElementChild;

      expect(feedCard).toHaveClass("border-border");
      expect(ancestorCard).not.toHaveClass("border-border");
      expect(ancestorCard).toHaveClass("cursor-pointer");
    });
  });

  describe("card-level navigation", () => {
    it("navigates to the thread when the card body is clicked", async () => {
      const post = makePost({ content: "Click anywhere on me" });
      const { router } = await renderWithProviders(<PostCard post={post} />);

      const user = userEvent.setup();
      await user.click(screen.getByText("Click anywhere on me"));

      expect(router.state.location.pathname).toBe(`/post/${post.id}`);
    });

    // The regression this guards against: a click that lands on a nested
    // link (or button) must resolve to THAT element's own destination, not
    // also trigger the card's own navigate() — see the
    // `target.closest("a, button, [role='button']")` guard in post-card.tsx.
    it("does not also navigate to the thread when a nested link is clicked", async () => {
      const author = makeAuthor({ username: "alexmercer" });
      const post = makePost({ author });
      const { router } = await renderWithProviders(<PostCard post={post} />);

      const user = userEvent.setup();
      await user.click(screen.getByRole("link", { name: new RegExp(author.name) }));

      expect(router.state.location.pathname).toBe(`/@${author.username}`);
      expect(router.state.location.pathname).not.toBe(`/post/${post.id}`);
    });
  });

  describe("author without a handle", () => {
    it("degrades to a non-link name and still renders", async () => {
      const author = makeAuthor({ username: null, displayUsername: null });
      const post = makePost({ author });
      await renderWithProviders(<PostCard post={post} />);

      expect(screen.getByText(author.name)).toBeInTheDocument();
      // No profile link exists at all — not an empty/broken one.
      expect(screen.queryByRole("link", { name: new RegExp(author.name) })).not.toBeInTheDocument();
    });
  });

  describe("the kebab menu", () => {
    it("offers Delete — and only Delete — on the viewer's own post, and names it as the dialog target", async () => {
      const author = makeAuthor();
      const post = makePost({ author });
      const store = createStore();
      await renderWithProviders(<PostCard post={post} />, {
        store,
        signedInAs: { id: author.id },
      });

      const user = userEvent.setup();
      await user.click(screen.getByLabelText(m.moderation_kebab()));
      const deleteItem = await screen.findByRole("menuitem", { name: m.post_delete() });

      // You cannot report or block yourself, so neither item belongs here.
      expect(
        screen.queryByRole("menuitem", { name: m.moderation_kebab_report_post() }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("menuitem", { name: m.moderation_kebab_block() }),
      ).not.toBeInTheDocument();

      await user.click(deleteItem);

      // The card only sets the target; the dialog itself is mounted at the
      // root layout (see `atoms/post-delete.ts`).
      expect(store.get(deletePostDialogAtom)).toBe(post.id);
    });

    it("offers Report/Block — and no Delete — on someone else's post", async () => {
      const post = makePost();
      await renderWithProviders(<PostCard post={post} />, { signedInAs: { id: "viewer-1" } });

      const user = userEvent.setup();
      await user.click(screen.getByLabelText(m.moderation_kebab()));

      expect(
        await screen.findByRole("menuitem", { name: m.moderation_kebab_report_post() }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: m.moderation_kebab_block() }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: m.post_delete() })).not.toBeInTheDocument();
    });

    it.each([
      ["already deleted", { deleted: true }],
      ["already removed by a moderator", { removed: true }],
    ])("hides the menu entirely on the viewer's own post that is %s", async (_state, tombstone) => {
      const author = makeAuthor();
      const post = makePost({ author, content: null, ...tombstone });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: { id: author.id } });

      expect(screen.queryByLabelText(m.moderation_kebab())).not.toBeInTheDocument();
    });

    it("keeps the report/block menu on someone else's removed post — the author is still reportable", async () => {
      const post = makePost({ removed: true, content: null });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: { id: "viewer-1" } });

      expect(screen.getByLabelText(m.moderation_kebab())).toBeInTheDocument();
    });
  });

  describe("the deleted stub", () => {
    it("says the author deleted it, never that it was removed, and offers no appeal", async () => {
      const post = makePost({ deleted: true, content: null, likeCount: 2, replyCount: 3 });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      expect(screen.getByText(m.post_deleted_stub())).toBeInTheDocument();
      expect(screen.queryByText(m.moderation_post_removed_stub())).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: m.moderation_post_removed_appeal() }),
      ).not.toBeInTheDocument();

      // Nothing left to like or reply to, same as the removal stub.
      expect(
        screen.queryByRole("button", { name: m.post_like({ count: "2" }) }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: m.reply_to_post({ count: "3" }) }),
      ).not.toBeInTheDocument();
    });
  });

  describe("content rendering", () => {
    it.each([
      ["post", null],
      ["reply", "parent-1"],
    ])("links mentions in a published %s to canonical profiles", async (_kind, parentId) => {
      const post = makePost({ content: "Hello @Alice!", parentId });
      const { router } = await renderWithProviders(<PostCard post={post} />);

      const user = userEvent.setup();
      const mention = screen.getByRole("link", { name: "@Alice" });
      expect(mention).toHaveAttribute("href", "/@alice");
      await user.click(mention);

      expect(router.state.location.pathname).toBe("/@alice");
      expect(router.state.location.pathname).not.toBe(`/post/${post.id}`);
    });

    it("preserves line breaks in the raw DOM text", async () => {
      const post = makePost({ content: "line one\nline two\nline three" });
      const { container } = await renderWithProviders(<PostCard post={post} />);

      const paragraph = container.querySelector("p");
      expect(paragraph).toHaveClass("whitespace-pre-line");
      expect(paragraph?.textContent).toBe("line one\nline two\nline three");
    });

    it("renders a long unbroken string without throwing", async () => {
      const post = makePost({ content: "a".repeat(2000) });
      await renderWithProviders(<PostCard post={post} />);

      expect(screen.getByText("a".repeat(2000))).toBeInTheDocument();
    });
  });
});
