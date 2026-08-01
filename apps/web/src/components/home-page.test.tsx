import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import { feedScopeAtom, type FeedScope } from "@/lib/feed-scope";

// Tests for ./home-page.tsx — specifically how the Following|Global scope is
// resolved, which depends on three inputs at once (the remembered choice,
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

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { HomePage } = await import("./home-page");

/**
 * A fresh Jotai store per render, so a scope set (or clicked) in one test can't
 * leak into the next. `feedScopeAtom` reads `localStorage` when the store
 * initialises it, which is why that is cleared in `beforeEach` too.
 */
function renderHome({ scope }: { scope?: FeedScope } = {}) {
  const store = createStore();
  if (scope) store.set(feedScopeAtom, scope);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <HomePage />
      </Provider>
    </QueryClientProvider>,
  );

  return store;
}

/** The input object the feed query was issued with. */
const feedInput = () => clientMock.post.list.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.current = null;
  sessionMock.pending = false;
  // `window.` is not optional: Node >= 22 defines its own bare `localStorage`
  // global, which vitest leaves in place over jsdom's and which is undefined
  // unless the process was started with --localstorage-file.
  window.localStorage.clear();
  clientMock.post.list.mockResolvedValue({ items: [], nextCursor: null });
});

describe("home feed scope", () => {
  it("defaults a signed-in visitor to the For you (global) feed", async () => {
    sessionMock.current = { user: { id: "viewer-1", name: "Viewer", image: null } };

    renderHome();
    await screen.findByRole("heading", { name: "Home" });

    expect(feedInput()).not.toHaveProperty("feed");
  });

  it("shows a signed-out visitor the global feed", async () => {
    renderHome();
    await screen.findByRole("heading", { name: "Home" });

    // `feed` is deliberately absent rather than "global": the conditional
    // spread keeps the global timeline's query key identical to what it was
    // before this feature, and the server owns the default.
    expect(feedInput()).not.toHaveProperty("feed");
  });

  it("ignores a remembered Following choice for a signed-out visitor", async () => {
    // The server would reject it, so honouring the stored scope would render an
    // error card instead of a usable page.
    renderHome({ scope: "following" });
    await screen.findByRole("heading", { name: "Home" });

    expect(feedInput()).not.toHaveProperty("feed");
  });

  it("honours a remembered Following choice for a signed-in visitor", async () => {
    sessionMock.current = { user: { id: "viewer-1", name: "Viewer", image: null } };

    renderHome({ scope: "following" });
    await screen.findByRole("heading", { name: "Home" });

    expect(feedInput()).toMatchObject({ feed: "following" });
  });

  it("falls back to the global feed when the stored value is garbage", async () => {
    // localStorage is user-editable and outlives deploys.
    window.localStorage.setItem("my-tuums.feed-scope", JSON.stringify("nonsense"));
    sessionMock.current = { user: { id: "viewer-1", name: "Viewer", image: null } };

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

    expect(screen.getByRole("button", { name: /^for you$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^following$/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("switches the feed on click and remembers the choice", async () => {
    const user = userEvent.setup();
    sessionMock.current = { user: { id: "viewer-1", name: "Viewer", image: null } };

    const store = renderHome();
    await screen.findByRole("heading", { name: "Home" });

    await user.click(screen.getByRole("button", { name: /^following$/i }));

    expect(screen.getByRole("button", { name: /^following$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(clientMock.post.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ feed: "following" }),
      expect.anything(),
    );
    // Persisted, not just held in the store — the point of dropping the URL
    // param was that the choice survives a reload.
    expect(store.get(feedScopeAtom)).toBe("following");
    expect(window.localStorage.getItem("my-tuums.feed-scope")).toBe(JSON.stringify("following"));
  });

  it("points people at /discover when the Following feed is empty", async () => {
    sessionMock.current = { user: { id: "viewer-1", name: "Viewer", image: null } };

    renderHome({ scope: "following" });

    expect(await screen.findByText(/you're not following anyone who's posted/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /find people to follow/i })).toHaveAttribute(
      "href",
      "/discover",
    );
  });
});
