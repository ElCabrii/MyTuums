import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// Tests for src/routes/index.tsx — specifically how the Following|Global
// scope is resolved, which depends on three inputs at once (the search param,
// whether there's a session, and whether the session has loaded yet).

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    post: { list: vi.fn(), like: vi.fn(), unlike: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { orpc: createTanstackQueryUtils(clientMock) };
});

const { sessionMock } = vi.hoisted(() => {
  const sessionMock: {
    current: { user: { id: string; name: string; image: string | null } } | null;
    pending: boolean;
  } = { current: null, pending: false };
  return { sessionMock };
});

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: sessionMock.current, isPending: sessionMock.pending }),
  authClient: { signOut: vi.fn() },
}));

const { searchMock } = vi.hoisted(() => {
  const searchMock: { current: { feed?: "following" | "global" } } = { current: {} };
  return { searchMock };
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    ...options,
    useSearch: () => searchMock.current,
  }),
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { HomePage } = await import("./index");

function renderHome() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <HomePage />
    </QueryClientProvider>,
  );
}

/** The input object the feed query was issued with. */
const feedInput = () => clientMock.post.list.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.current = null;
  sessionMock.pending = false;
  searchMock.current = {};
  clientMock.post.list.mockResolvedValue({ items: [], nextCursor: null });
});

describe("home feed scope", () => {
  it("defaults a signed-in visitor to the Following feed", async () => {
    sessionMock.current = { user: { id: "viewer-1", name: "Viewer", image: null } };

    renderHome();
    await screen.findByRole("heading", { name: "Home" });

    expect(feedInput()).toMatchObject({ feed: "following" });
  });

  it("shows a signed-out visitor the global feed", async () => {
    renderHome();
    await screen.findByRole("heading", { name: "Home" });

    // `feed` is deliberately absent rather than "global": the conditional
    // spread keeps the global timeline's query key identical to what it was
    // before this feature, and the server owns the default.
    expect(feedInput()).not.toHaveProperty("feed");
  });

  it("ignores ?feed=following for a signed-out visitor", async () => {
    // The server would reject it, so honouring the param would render an
    // error card instead of a usable page.
    searchMock.current = { feed: "following" };

    renderHome();
    await screen.findByRole("heading", { name: "Home" });

    expect(feedInput()).not.toHaveProperty("feed");
  });

  it("honours ?feed=global for a signed-in visitor", async () => {
    sessionMock.current = { user: { id: "viewer-1", name: "Viewer", image: null } };
    searchMock.current = { feed: "global" };

    renderHome();
    await screen.findByRole("heading", { name: "Home" });

    expect(feedInput()).not.toHaveProperty("feed");
  });

  it("waits for the session before requesting anything", () => {
    // useSession starts pending with data: null. Rendering the feed straight
    // away would request the global timeline, then flip to Following a tick
    // later and request again.
    sessionMock.pending = true;

    renderHome();

    expect(clientMock.post.list).not.toHaveBeenCalled();
  });

  it("offers the feed switch only when signed in", async () => {
    renderHome();
    await screen.findByRole("heading", { name: "Home" });
    expect(screen.queryByRole("button", { name: /^following$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/latest from everyone/i)).toBeInTheDocument();
  });

  it("marks the selected feed tab", async () => {
    sessionMock.current = { user: { id: "viewer-1", name: "Viewer", image: null } };

    renderHome();
    await screen.findByRole("heading", { name: "Home" });

    expect(screen.getByRole("button", { name: /^following$/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: /^global$/i })).not.toHaveAttribute("aria-current");
  });

  it("points people at /discover when the Following feed is empty", async () => {
    sessionMock.current = { user: { id: "viewer-1", name: "Viewer", image: null } };

    renderHome();

    expect(await screen.findByText(/you're not following anyone who's posted/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /find people to follow/i })).toHaveAttribute(
      "href",
      "/discover",
    );
  });
});
