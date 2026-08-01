import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

// The oRPC client is replaced wholesale, and `orpc` is rebuilt from the fake
// with the real `createTanstackQueryUtils`. That keeps the query keys, the
// infinite-query plumbing and the mutation options exactly as they are in the
// app — the part under test is how the cache is updated, and swapping the key
// factory for a hand-written one would test a different program.
const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    post: {
      list: vi.fn(),
      like: vi.fn(),
      unlike: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { orpc: createTanstackQueryUtils(clientMock) };
});

const { sessionMock } = vi.hoisted(() => {
  const sessionMock: { current: { user: { id: string } } | null } = {
    current: { user: { id: "viewer-1" } },
  };
  return { sessionMock };
});

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: sessionMock.current, isPending: false }),
  authClient: { signOut: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

// Imported after the mocks so it picks them up.
const { PostFeed } = await import("./post-feed");

interface FakePost {
  id: string;
  content: string;
  createdAt: Date;
  author: {
    id: string;
    name: string;
    username: string | null;
    displayUsername: string | null;
    image: string | null;
  };
  likeCount: number;
  viewerHasLiked: boolean;
}

function makePost(overrides: Partial<FakePost> = {}): FakePost {
  return {
    id: "post-1",
    content: "clutched a 1v5",
    createdAt: new Date(),
    author: {
      id: "author-1",
      name: "Alex Mercer",
      username: "alexmercer",
      displayUsername: "AlexMercer",
      image: null,
    },
    likeCount: 3,
    viewerHasLiked: false,
    ...overrides,
  };
}

/** A promise this test resolves or rejects by hand, to hold a request open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderFeed(posts: FakePost[] = [makePost()]) {
  clientMock.post.list.mockResolvedValue({ items: posts, nextCursor: null });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <PostFeed emptyMessage="No posts yet." />
    </QueryClientProvider>,
  );

  await screen.findByText(posts[0]?.content ?? "No posts yet.");
  return { user: userEvent.setup(), queryClient };
}

const likeButton = () => screen.getByRole("button", { name: /like this post/i });
const likeCount = () => likeButton().textContent?.replace(/\D/g, "");

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.current = { user: { id: "viewer-1" } };
});

describe("PostFeed", () => {
  it("renders a post with its author and like count", async () => {
    await renderFeed();

    expect(screen.getByText("Alex Mercer")).toBeInTheDocument();
    expect(screen.getByText("@alexmercer")).toBeInTheDocument();
    expect(screen.getByText("clutched a 1v5")).toBeInTheDocument();
    expect(likeButton()).toHaveAttribute("aria-pressed", "false");
    expect(likeCount()).toBe("3");
  });

  it("shows the empty state when there is nothing to show", async () => {
    clientMock.post.list.mockResolvedValue({ items: [], nextCursor: null });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <PostFeed emptyMessage="No posts yet." />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("No posts yet.")).toBeInTheDocument();
  });

  it("renders an emptyAction alongside the empty message", async () => {
    clientMock.post.list.mockResolvedValue({ items: [], nextCursor: null });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <PostFeed emptyMessage="No posts yet." emptyAction={<a href="/discover">Find people</a>} />
      </QueryClientProvider>,
    );

    await screen.findByText("No posts yet.");
    expect(screen.getByRole("link", { name: "Find people" })).toBeInTheDocument();
  });

  // The conditional spread is invisible in the rendered output but decides the
  // query key: keeping `feed` out of the global timeline's input is what makes
  // its cache identical to what it was before the Following feed existed.
  it("omits feed entirely for the global timeline", async () => {
    await renderFeed();

    expect(clientMock.post.list).toHaveBeenCalledWith(
      expect.not.objectContaining({ feed: expect.anything() as unknown }),
      expect.anything(),
    );
  });

  it("sends feed: following when scoped to the follow graph", async () => {
    clientMock.post.list.mockResolvedValue({ items: [], nextCursor: null });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <PostFeed feed="following" emptyMessage="No posts yet." />
      </QueryClientProvider>,
    );

    await screen.findByText("No posts yet.");
    expect(clientMock.post.list).toHaveBeenCalledWith(
      expect.objectContaining({ feed: "following" }),
      expect.anything(),
    );
  });

  it("surfaces a failed load with a retry", async () => {
    clientMock.post.list.mockRejectedValue(new Error("network is down"));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <PostFeed emptyMessage="No posts yet." />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("network is down");
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  describe("liking", () => {
    it("updates the count before the request comes back", async () => {
      const pending = deferred<unknown>();
      clientMock.post.like.mockReturnValue(pending.promise);

      const { user } = await renderFeed();
      await user.click(likeButton());

      // Still in flight — this is the optimistic write, not the response.
      expect(clientMock.post.like).toHaveBeenCalledWith({ postId: "post-1" }, expect.anything());
      expect(likeCount()).toBe("4");
      expect(screen.getByRole("button", { name: /unlike this post/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("takes the authoritative count from the response", async () => {
      // Someone else liked it too while the request was in flight.
      clientMock.post.like.mockResolvedValue({
        postId: "post-1",
        likeCount: 9,
        viewerHasLiked: true,
      });

      const { user } = await renderFeed();
      await user.click(likeButton());

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /unlike this post/i })).toHaveTextContent("9");
      });
    });

    it("puts the count back when the request fails", async () => {
      clientMock.post.like.mockRejectedValue(new Error("nope"));

      const { user } = await renderFeed();
      await user.click(likeButton());

      await waitFor(() => {
        expect(likeButton()).toHaveAttribute("aria-pressed", "false");
      });
      expect(likeCount()).toBe("3");
    });

    it("unlikes a post the viewer already liked", async () => {
      clientMock.post.unlike.mockResolvedValue({
        postId: "post-1",
        likeCount: 2,
        viewerHasLiked: false,
      });

      const { user } = await renderFeed([makePost({ likeCount: 3, viewerHasLiked: true })]);
      await user.click(screen.getByRole("button", { name: /unlike this post/i }));

      await waitFor(() => {
        expect(likeButton()).toHaveAttribute("aria-pressed", "false");
      });
      expect(clientMock.post.unlike).toHaveBeenCalledTimes(1);
      expect(clientMock.post.like).not.toHaveBeenCalled();
    });

    // The regression this whole design exists for. Unscoped, the two requests
    // raced: the unlike response could land first and the like response
    // second, so the success handler reconciled from the stale one and the UI
    // settled on "liked" while the server had the post unliked.
    it("ends up unliked when a like is immediately undone", async () => {
      const likeCall = deferred<unknown>();
      const unlikeCall = deferred<unknown>();
      clientMock.post.like.mockReturnValue(likeCall.promise);
      clientMock.post.unlike.mockReturnValue(unlikeCall.promise);

      const { user } = await renderFeed();

      await user.click(likeButton());
      expect(likeCount()).toBe("4");

      await user.click(screen.getByRole("button", { name: /unlike this post/i }));
      // The second click shows immediately even though its request cannot
      // start until the first one finishes.
      expect(likeCount()).toBe("3");
      expect(clientMock.post.unlike).not.toHaveBeenCalled();

      // The like resolves saying "liked, 4" — the truth at the time it ran,
      // but no longer what the viewer wants. Reconciling from it here is
      // exactly the bug.
      likeCall.resolve({ postId: "post-1", likeCount: 4, viewerHasLiked: true });

      await waitFor(() => {
        expect(clientMock.post.unlike).toHaveBeenCalledTimes(1);
      });
      expect(likeButton()).toHaveAttribute("aria-pressed", "false");
      expect(likeCount()).toBe("3");

      unlikeCall.resolve({ postId: "post-1", likeCount: 3, viewerHasLiked: false });

      await waitFor(() => {
        expect(likeButton()).toHaveAttribute("aria-pressed", "false");
      });
      expect(likeCount()).toBe("3");
    });

    it("serialises requests so the server sees the clicks in order", async () => {
      const order: string[] = [];
      const likeCall = deferred<unknown>();

      clientMock.post.like.mockImplementation(() => {
        order.push("like");
        return likeCall.promise;
      });
      clientMock.post.unlike.mockImplementation(() => {
        order.push("unlike");
        return Promise.resolve({ postId: "post-1", likeCount: 3, viewerHasLiked: false });
      });

      const { user } = await renderFeed();

      await user.click(likeButton());
      await user.click(screen.getByRole("button", { name: /unlike this post/i }));

      expect(order).toEqual(["like"]);

      likeCall.resolve({ postId: "post-1", likeCount: 4, viewerHasLiked: true });

      await waitFor(() => {
        expect(order).toEqual(["like", "unlike"]);
      });
    });

    it("settles on the last click after a burst", async () => {
      clientMock.post.like.mockResolvedValue({
        postId: "post-1",
        likeCount: 4,
        viewerHasLiked: true,
      });
      clientMock.post.unlike.mockResolvedValue({
        postId: "post-1",
        likeCount: 3,
        viewerHasLiked: false,
      });

      const { user } = await renderFeed();

      // like, unlike, like — an odd number of clicks, so the post ends liked.
      await user.click(likeButton());
      await user.click(screen.getByRole("button", { name: /unlike this post/i }));
      await user.click(likeButton());

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /unlike this post/i })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
      });
      expect(clientMock.post.like).toHaveBeenCalledTimes(2);
      expect(clientMock.post.unlike).toHaveBeenCalledTimes(1);
    });

    it("sends signed-out viewers to log in instead of firing a request", async () => {
      sessionMock.current = null;

      await renderFeed();

      expect(screen.queryByRole("button", { name: /like this post/i })).not.toBeInTheDocument();
      expect(screen.getByTitle(/log in to like posts/i)).toHaveAttribute("href", "/login");
      expect(clientMock.post.like).not.toHaveBeenCalled();
    });
  });
});
