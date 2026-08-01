import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ORPCError } from "@orpc/client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

// Tests for src/routes/@{$username}.tsx (the layout) and
// src/routes/@{$username}.index.tsx (the Posts tab). Neither test file can be
// named after its route — the TanStack Router plugin would pick it up — though
// `routeFileIgnorePattern` in vite.config.ts now also guards that.

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    post: { list: vi.fn(), like: vi.fn(), unlike: vi.fn(), create: vi.fn() },
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
  const actual = await vi.importActual<typeof import("@/lib/orpc")>("@/lib/orpc");
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return {
    orpc: createTanstackQueryUtils(clientMock),
    // The retry predicate is real logic under test (it's what stops a 404
    // being retried), so it comes from the module rather than a stub.
    retryUnlessClientError: actual.retryUnlessClientError,
  };
});

const { sessionMock, signOutMock } = vi.hoisted(() => ({
  sessionMock: {
    current: null as { user: { id: string; email: string } } | null,
  },
  signOutMock: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: sessionMock.current, isPending: false }),
  authClient: { signOut: signOutMock },
}));

const { paramsMock, pathnameMock } = vi.hoisted(() => ({
  paramsMock: { current: { username: "alexmercer" } },
  pathnameMock: { current: "/@alexmercer" },
}));

vi.mock("@tanstack/react-router", () => ({
  // `createFileRoute(path)(options)` — the second call is where the component
  // lands. Handing back `useParams` alongside it is enough for the route
  // module's own `Route.useParams()` to work.
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    ...options,
    useParams: () => paramsMock.current,
  }),
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: pathnameMock.current }),
  // The layout's children are exercised by rendering them alongside it below,
  // so the outlet itself only needs to not blow up.
  Outlet: () => null,
}));

const { ProfileLayout } = await import("./@{$username}");
const { ProfilePosts } = await import("./@{$username}.index");

const PROFILE = {
  id: "author-1",
  name: "Alex Mercer",
  username: "alexmercer",
  displayUsername: "AlexMercer",
  image: null,
  createdAt: new Date(2026, 7, 15),
  followerCount: 1234,
  followingCount: 42,
  viewerIsFollowing: false,
};

/**
 * Renders the layout and the Posts tab as siblings, which is what the router
 * composes at `/@alexmercer` once `<Outlet />` resolves.
 */
function renderProfile() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ProfileLayout />
      <ProfilePosts />
    </QueryClientProvider>,
  );

  return { user: userEvent.setup(), queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  paramsMock.current = { username: "alexmercer" };
  pathnameMock.current = "/@alexmercer";
  sessionMock.current = null;
  clientMock.post.list.mockResolvedValue({ items: [], nextCursor: null });
  clientMock.user.byUsername.mockResolvedValue(PROFILE);
  clientMock.user.follow.mockResolvedValue({
    userId: "author-1",
    followerCount: 1235,
    viewerIsFollowing: true,
  });
  clientMock.user.unfollow.mockResolvedValue({
    userId: "author-1",
    followerCount: 1234,
    viewerIsFollowing: false,
  });
});

describe("profile page", () => {
  it("renders a stranger's profile from the handle in the URL", async () => {
    renderProfile();

    expect(await screen.findByRole("heading", { name: "Alex Mercer" })).toBeInTheDocument();
    expect(screen.getByText("@AlexMercer")).toBeInTheDocument();
    expect(screen.getByText("Joined August 2026")).toBeInTheDocument();
    expect(clientMock.user.byUsername).toHaveBeenCalledWith(
      { username: "alexmercer" },
      expect.anything(),
    );
  });

  it("loads that person's posts, not the signed-in user's", async () => {
    sessionMock.current = { user: { id: "viewer-9", email: "viewer@example.com" } };

    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    expect(clientMock.post.list).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: "author-1" }),
      expect.anything(),
    );
  });

  it("keeps the owner's controls off someone else's profile", async () => {
    sessionMock.current = { user: { id: "viewer-9", email: "viewer@example.com" } };

    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit profile/i })).not.toBeInTheDocument();
    // No composer: you can't post as someone else.
    expect(screen.queryByRole("button", { name: /^post$/i })).not.toBeInTheDocument();
    expect(await screen.findByText(/@alexmercer hasn't posted anything yet/i)).toBeInTheDocument();
  });

  // `user.byUsername` is public, so it deliberately doesn't return an email
  // at all. This is the UI half of that: the address on screen comes from the
  // viewer's own session, and only when they're looking at themselves.
  it("never shows another person's email address", async () => {
    sessionMock.current = { user: { id: "viewer-9", email: "viewer@example.com" } };

    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    expect(screen.queryByText("viewer@example.com")).not.toBeInTheDocument();
  });

  it("shows the owner their controls and their own email", async () => {
    sessionMock.current = { user: { id: "author-1", email: "alex@example.com" } };

    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit profile/i })).toBeInTheDocument();
    expect(screen.getByText("alex@example.com")).toBeInTheDocument();
    expect(await screen.findByText(/you haven't posted anything yet/i)).toBeInTheDocument();
  });

  it("resolves the profile whatever case the handle is typed in", async () => {
    paramsMock.current = { username: "AlexMercer" };

    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    // Normalising is the server's job — the client passes the handle through.
    expect(clientMock.user.byUsername).toHaveBeenCalledWith(
      { username: "AlexMercer" },
      expect.anything(),
    );
  });

  it("says the handle is free when nobody has it", async () => {
    paramsMock.current = { username: "nobodyhome" };
    clientMock.user.byUsername.mockRejectedValue(new ORPCError("NOT_FOUND"));

    renderProfile();

    expect(await screen.findByText(/this handle isn't taken/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "@nobodyhome" })).toBeInTheDocument();
  });

  it("does not retry a handle the server said does not exist", async () => {
    clientMock.user.byUsername.mockRejectedValue(new ORPCError("NOT_FOUND"));

    renderProfile();
    await screen.findByText(/this handle isn't taken/i);

    expect(clientMock.user.byUsername).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when the failure might be transient", async () => {
    clientMock.user.byUsername.mockRejectedValue(new Error("network is down"));

    renderProfile();

    expect(await screen.findByText(/couldn't load this profile/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(clientMock.user.byUsername.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("profile follow graph", () => {
  it("shows follower and following counts, compacted, linking to each list", async () => {
    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    const followers = screen.getByRole("link", { name: /followers/i });
    const following = screen.getByRole("link", { name: /following/i });

    expect(followers).toHaveTextContent("1.2K");
    expect(following).toHaveTextContent("42");
    expect(followers).toHaveAttribute("href", "/@{$username}/followers");
    expect(following).toHaveAttribute("href", "/@{$username}/following");
  });

  it("singularises a lone follower", async () => {
    clientMock.user.byUsername.mockResolvedValue({ ...PROFILE, followerCount: 1 });

    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    expect(screen.getByRole("link", { name: /1 follower$/i })).toBeInTheDocument();
  });

  it("offers a Follow button on someone else's profile", async () => {
    sessionMock.current = { user: { id: "viewer-9", email: "viewer@example.com" } };

    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    expect(screen.getByRole("button", { name: /^follow$/i })).toBeInTheDocument();
  });

  it("does not offer a Follow button on your own profile", async () => {
    sessionMock.current = { user: { id: "author-1", email: "alex@example.com" } };

    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    expect(screen.queryByRole("button", { name: /^follow$/i })).not.toBeInTheDocument();
  });

  it("sends a signed-out visitor to log in rather than into a 401", async () => {
    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    // `Button nativeButton={false}` applies Base UI's button semantics, so
    // this reports as a button — but it is a Link underneath and keeps the
    // href, which is the part that matters here.
    const follow = screen.getByRole("button", { name: /^follow$/i });
    expect(follow).toHaveAttribute("href", "/login");
    expect(clientMock.user.follow).not.toHaveBeenCalled();
  });

  it("flips the button and bumps the count optimistically", async () => {
    sessionMock.current = { user: { id: "viewer-9", email: "viewer@example.com" } };

    const { user } = renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    await user.click(screen.getByRole("button", { name: /^follow$/i }));

    expect(screen.getByRole("button", { name: /^unfollow$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /followers/i })).toHaveTextContent("1.2K");
    expect(clientMock.user.follow).toHaveBeenCalledWith({ userId: "author-1" }, expect.anything());
  });

  it("rolls the button back when the follow fails", async () => {
    sessionMock.current = { user: { id: "viewer-9", email: "viewer@example.com" } };
    clientMock.user.follow.mockRejectedValue(new Error("network is down"));

    const { user } = renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    await user.click(screen.getByRole("button", { name: /^follow$/i }));

    expect(await screen.findByRole("button", { name: /^follow$/i })).toBeInTheDocument();
  });

  it("marks the active profile tab", async () => {
    pathnameMock.current = "/@alexmercer/followers";

    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    const followersTab = screen.getByRole("button", { name: /^followers$/i });
    expect(followersTab).toHaveAttribute("aria-current", "page");

    // ...and the sibling tabs are not marked.
    expect(screen.getByRole("button", { name: /^posts$/i })).not.toHaveAttribute("aria-current");
  });
});
