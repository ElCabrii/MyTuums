import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { createStore } from "jotai";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { makeAuthor, makePost } from "@/test/factories";
import { renderWithProviders } from "@/test/render";
import { installTestOrpc, orpc } from "@/lib/orpc";
import { quoteDialogAtom } from "@/atoms/quote-composer";
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
    repost: vi.fn(() => Promise.resolve({ postId: "", repostCount: 0, viewerHasReposted: true })),
    unrepost: vi.fn(() =>
      Promise.resolve({ postId: "", repostCount: 0, viewerHasReposted: false }),
    ),
    bookmark: vi.fn(() => Promise.resolve({ postId: "", viewerHasBookmarked: true })),
    unbookmark: vi.fn(() => Promise.resolve({ postId: "", viewerHasBookmarked: false })),
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

    // The wiring only: the pressed state and the accessible name, plus "the
    // button asked the transport to bookmark this exact post". The optimistic
    // flip, rollback and intent handling are owned by `atoms/bookmark.ts`.
    it("renders the bookmark control as a pressed toggle when already saved, and invokes the toggle on click", async () => {
      const post = makePost({ viewerHasBookmarked: true });
      const queryClient = new QueryClient();
      seedPostCache(queryClient, post);
      await renderWithProviders(<PostCard post={post} />, { queryClient, signedInAs: true });

      const bookmarkButton = screen.getByRole("button", { name: m.post_unbookmark() });
      expect(bookmarkButton).toHaveAttribute("aria-pressed", "true");

      const user = userEvent.setup();
      await user.click(bookmarkButton);

      await waitFor(() =>
        expect(fakeClient.post.unbookmark).toHaveBeenCalledWith(
          { postId: post.id },
          expect.anything(),
        ),
      );
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

  describe("reply parent context", () => {
    it("labels the reply with its parent and links the label to the parent's thread", async () => {
      const parentAuthor = makeAuthor({ name: "Parent Author", username: "parent" });
      const post = makePost({
        id: "reply-1",
        parentId: "parent-1",
        parent: {
          id: "parent-1",
          excerpt: "The original post",
          truncated: false,
          removed: false,
          author: parentAuthor,
        },
      });
      const { router } = await renderWithProviders(<PostCard post={post} />);

      // The quiet one-line label replaced the boxed excerpt: the parent's
      // text is no longer quoted into every reply card.
      const parentLink = screen.getByRole("link", {
        name: m.reply_parent_label({ name: parentAuthor.name }),
      });
      expect(parentLink).toHaveAttribute("href", "/post/parent-1");
      expect(screen.queryByText("The original post")).not.toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(parentLink);
      expect(router.state.location.pathname).toBe("/post/parent-1");
      expect(router.state.location.pathname).not.toBe("/post/reply-1");
    });

    it("keeps an inline why next to the label when the parent was removed", async () => {
      const parentAuthor = makeAuthor({ name: "Parent Author", username: "parent" });
      const post = makePost({
        parentId: "parent-1",
        parent: {
          id: "parent-1",
          excerpt: null,
          truncated: false,
          removed: true,
          author: parentAuthor,
        },
      });
      await renderWithProviders(<PostCard post={post} />);

      const label = screen.getByRole("link", {
        name: m.reply_parent_label({ name: parentAuthor.name }),
      });
      // The why rides the same line as the label, not a separate box.
      expect(label.closest("p")).toHaveTextContent(m.moderation_post_removed_stub());
    });

    it("does not add parent context to a top-level post", async () => {
      const post = makePost({ parentId: null, parent: null });
      await renderWithProviders(<PostCard post={post} />);

      expect(screen.queryByText(m.reply_parent_unavailable())).not.toBeInTheDocument();
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

    // Not clicked: jsdom cannot follow an external navigation, and the
    // card-level guard that keeps an anchor click off `navigate()` is already
    // covered above — it matches any `<a>`, mention or URL alike.
    it.each([
      ["post", null],
      ["reply", "parent-1"],
    ])("renders a URL in a published %s as a safe external link", async (_kind, parentId) => {
      const post = makePost({ content: "docs at https://example.com/a, worth a read", parentId });
      await renderWithProviders(<PostCard post={post} />);

      const link = screen.getByRole("link", { name: "https://example.com/a" });
      expect(link).toHaveAttribute("href", "https://example.com/a");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
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

    // An image-only post (issue #202) stores `content` as ""; rendering must
    // omit the paragraph entirely rather than leave a blank block above the
    // attachment grid.
    it("omits the text paragraph for an image-only post and still renders its attachments", async () => {
      const post = makePost({
        content: "",
        attachments: [
          {
            id: "attachment-1",
            url: "/media/posts/author/post/attachment-1.png",
            position: 0,
            contentType: "image/png",
            byteSize: 24,
            width: 256,
            height: 128,
          },
        ],
      });
      const { container } = await renderWithProviders(<PostCard post={post} />);

      // The stub-route <p> the test harness renders also matches a bare tag
      // query; the content paragraph is the one carrying `whitespace-pre-line`.
      expect(container.querySelector("p.whitespace-pre-line")).toBeNull();
      expect(screen.getByAltText(m.post_attachment_alt({ position: "1" }))).toBeInTheDocument();
    });

    // Issue #203: attachments are viewer triggers now, not raw media links —
    // nothing inside a card should hand the reader a storage URL in a new tab.
    it("renders authoritative post attachments as viewer triggers rather than media links", async () => {
      const post = makePost({
        attachments: [
          {
            id: "attachment-1",
            url: "/media/posts/author/post/attachment-1.png",
            position: 0,
            contentType: "image/png",
            byteSize: 24,
            width: 256,
            height: 128,
          },
          {
            id: "attachment-2",
            url: "/media/posts/author/post/attachment-2.webp",
            position: 1,
            contentType: "image/webp",
            byteSize: 32,
            width: 128,
            height: 256,
          },
        ],
      });
      await renderWithProviders(<PostCard post={post} />);

      expect(
        screen.getByRole("button", { name: m.post_attachment_view({ position: "1" }) }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: m.post_attachment_view({ position: "2" }) }),
      ).toBeInTheDocument();
      const thumbnail = screen.getByAltText(m.post_attachment_alt({ position: "1" }));
      expect(thumbnail).toHaveAttribute("src", post.attachments[0]?.url);
      expect(document.querySelector('a[href^="/media/"]')).toBeNull();
    });

    // Card navigation and image-viewer activation must not conflict: opening
    // the viewer claims the click instead of also navigating to the thread.
    it("opens an attachment in the viewer without navigating to the thread", async () => {
      const post = makePost({
        content: "",
        attachments: [
          {
            id: "attachment-1",
            url: "/media/posts/author/post/attachment-1.png",
            position: 0,
            contentType: "image/png",
            byteSize: 24,
            width: 256,
            height: 128,
          },
        ],
      });
      const { router } = await renderWithProviders(<PostCard post={post} />);

      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: m.post_attachment_view({ position: "1" }) }),
      );

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/");
      expect(router.state.location.pathname).not.toBe(`/post/${post.id}`);
    });
  });

  // Issue #261: repost events and quoted posts. The degradation matrix —
  // deleted, removed, hidden — is decided by the server's projection; these
  // pin that the card renders what the projection says rather than guessing.
  describe("reposts and quotes", () => {
    it("attributes a reposted event to the reposter while the author stays the original's", async () => {
      const reposter = makeAuthor({ name: "Reposter Name", username: "reposter" });
      const post = makePost({
        repostedBy: { ...reposter, repostedAt: new Date("2026-08-30T10:00:00Z") },
      });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      expect(screen.getByText(m.post_reposted_by({ name: "Reposter Name" }))).toBeInTheDocument();
    });

    it("renders the repost control as a pressed toggle and invokes the toggle on click", async () => {
      const post = makePost({ viewerHasReposted: true, repostCount: 5 });
      const queryClient = new QueryClient();
      seedPostCache(queryClient, post);
      await renderWithProviders(<PostCard post={post} />, { queryClient, signedInAs: true });

      const repostButton = screen.getByRole("button", { name: m.post_unrepost({ count: "5" }) });
      expect(repostButton).toHaveAttribute("aria-pressed", "true");

      const user = userEvent.setup();
      await user.click(repostButton);

      await waitFor(() =>
        expect(fakeClient.post.unrepost).toHaveBeenCalledWith(
          { postId: post.id },
          expect.anything(),
        ),
      );
    });

    // The server would accept a repost of a reply, but no shipped surface can
    // show that event — the home feeds' repost arm excludes replies and
    // profile feeds run no repost arm — so a control whose effect is a dead
    // end is not offered. The reply's other controls stay.
    it("hides the repost control on a reply, while keeping the like control", async () => {
      const post = makePost({ parentId: "parent-1", parent: null });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      expect(
        screen.queryByRole("button", { name: m.post_repost({ count: String(post.repostCount) }) }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", {
          name: m.post_unrepost({ count: String(post.repostCount) }),
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: m.post_like({ count: String(post.likeCount) }) }),
      ).toBeInTheDocument();
    });

    it("embeds the quoted post with its own author and a dedicated permalink header", async () => {
      const quotedAuthor = makeAuthor({ name: "Quoted Author" });
      const post = makePost({
        content: "look at this",
        quotedPostId: "quoted-1",
        quoted: {
          id: "quoted-1",
          content: "the quoted words at https://example.com",
          removed: false,
          deleted: false,
          removedReason: null,
          attachments: [],
          author: quotedAuthor,
        },
      });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      const quotedPermalink = screen.getByRole("link", { name: /Quoted Author/ });
      expect(quotedPermalink).toHaveAttribute("href", "/post/quoted-1");
      expect(screen.getByText(/the quoted words at/)).toBeInTheDocument();
      // The quoted body keeps its own safe links; it is not nested inside the
      // quoted-post permalink.
      expect(screen.getByRole("link", { name: "https://example.com" })).toHaveAttribute(
        "href",
        "https://example.com/",
      );
    });

    it("renders a blocked original as unavailable while preserving only the reposter attribution", async () => {
      const post = makePost({
        unavailable: true,
        content: null,
        author: { id: "", name: "", username: null, displayUsername: null, image: null },
        repostedBy: {
          id: "reposter-1",
          name: "Reposter Name",
          username: "reposter",
          displayUsername: "Reposter",
          image: null,
          repostedAt: new Date("2026-08-30T10:00:00Z"),
        },
      });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      expect(screen.getByText(m.post_reposted_by({ name: "Reposter Name" }))).toBeInTheDocument();
      expect(screen.getByText(m.post_quoted_unavailable())).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Unknown/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: m.post_quote() })).not.toBeInTheDocument();
    });

    it("offers the original author the appeal path from a removed quoted-post stub", async () => {
      const post = makePost({
        content: "quote survives",
        quotedPostId: "quoted-1",
        quoted: {
          id: "quoted-1",
          content: null,
          removed: true,
          deleted: false,
          removedReason: "spam",
          attachments: [],
          author: makeAuthor(),
        },
      });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      expect(screen.getByText(m.moderation_post_removed_stub())).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: m.moderation_post_removed_appeal() }),
      ).toHaveAttribute("href", "/appeal?postId=quoted-1");
    });

    it("renders the deletion stub in place of a deleted quoted post, keeping the quote's own text", async () => {
      const post = makePost({
        content: "quote survives",
        quotedPostId: "quoted-1",
        quoted: {
          id: "quoted-1",
          content: null,
          removed: false,
          deleted: true,
          removedReason: null,
          attachments: [],
          author: makeAuthor(),
        },
      });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      expect(screen.getByText("quote survives")).toBeInTheDocument();
      expect(screen.getByText(m.post_deleted_stub())).toBeInTheDocument();
    });

    it("renders the unavailable card when the quoted author is hidden from the viewer", async () => {
      const post = makePost({ quotedPostId: "quoted-1", quoted: null });
      await renderWithProviders(<PostCard post={post} />, { signedInAs: true });

      expect(screen.getByText(m.post_quoted_unavailable())).toBeInTheDocument();
    });

    it("opens the quote dialog with the post as its target", async () => {
      const store = createStore();
      const post = makePost();
      await renderWithProviders(<PostCard post={post} />, { store, signedInAs: true });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: m.post_quote() }));

      expect(store.get(quoteDialogAtom)?.id).toBe(post.id);
    });
  });
});
