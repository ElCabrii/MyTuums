import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { atom } from "jotai";
import { renderWithProviders, makeAuthor, makePost } from "@/test/render";
import { PostCard } from "@/components/post-card";
import { m } from "@/paraglide/messages.js";

// PostCard's like button is a write-only atom (`useSetAtom`, never
// `useAtom`) — see `atoms/like.ts`. Mocking the family lets these tests
// assert "clicking the button asks to toggle this exact post" without also
// exercising the real mutation's network round trip, which
// jsdom has no server to answer.
const toggleLikeSpy = vi.fn();
vi.mock("@/atoms/like", () => ({
  toggleLikeAtomFamily: (postId: string) =>
    atom(null, () => {
      toggleLikeSpy(postId);
    }),
}));

describe("PostCard", () => {
  beforeEach(() => {
    toggleLikeSpy.mockClear();
  });

  describe("signed in", () => {
    it("renders the like control as a pressed toggle when already liked, and invokes the toggle on click", async () => {
      const post = makePost({ viewerHasLiked: true, likeCount: 3 });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      const likeButton = screen.getByRole("button", { name: m.post_unlike({ count: "3" }) });
      expect(likeButton).toHaveAttribute("aria-pressed", "true");

      const user = userEvent.setup();
      await user.click(likeButton);

      expect(toggleLikeSpy).toHaveBeenCalledWith(post.id);
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

  describe("content rendering", () => {
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
