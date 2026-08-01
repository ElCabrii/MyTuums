import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

// Same mocking idiom as ./post-feed.test.tsx: the fake client is wrapped in
// the *real* `createTanstackQueryUtils` so query keys and the infinite-query
// plumbing are the app's own.
const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    post: { list: vi.fn() },
    user: {
      byUsername: vi.fn(),
      follow: vi.fn(),
      unfollow: vi.fn(),
      followers: vi.fn(),
      following: vi.fn(),
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

const { UserList } = await import("./user-list");

interface FakeUser {
  id: string;
  name: string;
  username: string | null;
  displayUsername: string | null;
  image: string | null;
  createdAt: Date;
  followedAt: Date;
  viewerIsFollowing: boolean;
}

function makeUser(overrides: Partial<FakeUser> = {}): FakeUser {
  return {
    id: "user-1",
    name: "Alex Mercer",
    username: "alexmercer",
    displayUsername: "AlexMercer",
    image: null,
    createdAt: new Date(2026, 7, 15),
    followedAt: new Date(2026, 7, 20),
    viewerIsFollowing: false,
    ...overrides,
  };
}

function renderList(direction: "followers" | "following" = "followers") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <UserList username="targetuser" direction={direction} emptyMessage="Nobody here yet." />
    </QueryClientProvider>,
  );

  return { user: userEvent.setup(), queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.current = { user: { id: "viewer-1" } };
  clientMock.user.followers.mockResolvedValue({ items: [makeUser()], nextCursor: null });
  clientMock.user.following.mockResolvedValue({ items: [], nextCursor: null });
  clientMock.user.follow.mockResolvedValue({
    userId: "user-1",
    followerCount: 1,
    viewerIsFollowing: true,
  });
});

describe("UserList", () => {
  it("lists people and links each to their profile", async () => {
    renderList();

    expect(await screen.findByText("Alex Mercer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /alex mercer/i })).toHaveAttribute(
      "href",
      "/@{$username}",
    );
    expect(clientMock.user.followers).toHaveBeenCalledWith(
      expect.objectContaining({ username: "targetuser" }),
      expect.anything(),
    );
  });

  it("calls the procedure matching the direction", async () => {
    renderList("following");

    await screen.findByText("Nobody here yet.");
    expect(clientMock.user.following).toHaveBeenCalled();
    expect(clientMock.user.followers).not.toHaveBeenCalled();
  });

  it("shows the empty message when there is nobody", async () => {
    clientMock.user.followers.mockResolvedValue({ items: [], nextCursor: null });

    renderList();

    expect(await screen.findByText("Nobody here yet.")).toBeInTheDocument();
  });

  it("carries a working follow control on each row", async () => {
    const { user } = renderList();
    await screen.findByText("Alex Mercer");

    await user.click(screen.getByRole("button", { name: /^follow$/i }));

    expect(screen.getByRole("button", { name: /^unfollow$/i })).toBeInTheDocument();
    expect(clientMock.user.follow).toHaveBeenCalledWith({ userId: "user-1" }, expect.anything());
  });

  it("reflects a row the viewer already follows", async () => {
    clientMock.user.followers.mockResolvedValue({
      items: [makeUser({ viewerIsFollowing: true })],
      nextCursor: null,
    });

    renderList();

    expect(await screen.findByRole("button", { name: /^unfollow$/i })).toBeInTheDocument();
  });

  it("omits the follow control on the viewer's own row", async () => {
    clientMock.user.followers.mockResolvedValue({
      items: [makeUser({ id: "viewer-1" })],
      nextCursor: null,
    });

    renderList();
    await screen.findByText("Alex Mercer");

    expect(screen.queryByRole("button", { name: /^follow$/i })).not.toBeInTheDocument();
  });

  it("pages on demand", async () => {
    clientMock.user.followers.mockResolvedValueOnce({
      items: [makeUser()],
      nextCursor: "cursor-2",
    });
    clientMock.user.followers.mockResolvedValueOnce({
      items: [makeUser({ id: "user-2", name: "Sam Vega", username: "samvega" })],
      nextCursor: null,
    });

    const { user } = renderList();
    await screen.findByText("Alex Mercer");

    await user.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByText("Sam Vega")).toBeInTheDocument();
    expect(clientMock.user.followers).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "cursor-2" }),
      expect.anything(),
    );
  });

  it("offers a retry when the list fails to load", async () => {
    clientMock.user.followers.mockRejectedValue(new Error("network is down"));

    renderList();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
