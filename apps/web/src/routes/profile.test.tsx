import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ORPCError } from "@orpc/client";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// Tests for src/routes/@{$username}.tsx. The file itself can't be named
// `@{$username}.test.tsx` — the TanStack Router plugin would pick it up as a
// route.

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    post: { list: vi.fn(), like: vi.fn(), unlike: vi.fn(), create: vi.fn() },
    user: { byUsername: vi.fn() },
  },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { orpc: createTanstackQueryUtils(clientMock) };
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

const { paramsMock } = vi.hoisted(() => ({ paramsMock: { current: { username: "alexmercer" } } }));

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
}));

const { ProfilePage } = await import("./@{$username}");

const PROFILE = {
  id: "author-1",
  name: "Alex Mercer",
  username: "alexmercer",
  displayUsername: "AlexMercer",
  image: null,
  createdAt: new Date(2026, 7, 15),
};

function renderProfile() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ProfilePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  paramsMock.current = { username: "alexmercer" };
  sessionMock.current = null;
  clientMock.post.list.mockResolvedValue({ items: [], nextCursor: null });
  clientMock.user.byUsername.mockResolvedValue(PROFILE);
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
    expect(await screen.findByText(/@AlexMercer hasn't posted anything yet/)).toBeInTheDocument();
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

  it("labels the placeholder sections so they don't read as real data", async () => {
    renderProfile();
    await screen.findByRole("heading", { name: "Alex Mercer" });

    expect(screen.getAllByText(/sample data/i).length).toBeGreaterThan(0);
  });
});
