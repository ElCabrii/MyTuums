import type { ReactElement, ReactNode } from "react";
import { act, render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { vi } from "vitest";
import { FOLLOW_PAGE_SIZE, POST_PAGE_SIZE } from "@my-tuums/api/constants";
import { orpc, type Post, type PostListPage, type UserListPage, type UserSummary } from "@/lib/orpc";

/**
 * The shared harness every component test in this directory renders through.
 * Two concerns live here because every test needs both: a Jotai store wired
 * up the way `src/lib/store.ts` wires the real one, and a memory router
 * standing in for `src/routeTree.gen.ts` (generated, git-ignored — see
 * CLAUDE.md, so tests can't depend on it).
 */

// ---------------------------------------------------------------------------
// Query client
// ---------------------------------------------------------------------------

/**
 * `retry: false` so a seeded error state (see `seedInfiniteError` below)
 * surfaces immediately instead of a test waiting out retry backoff.
 * `refetchOnMount: false` so a query that already has data or an error
 * seeded via `queryClient.setQueryData` / `fetchInfiniteQuery` stays exactly
 * as seeded when a component mounts and observes it, instead of firing a
 * real (network-dependent, unmockable-without-a-lot-of-effort) background
 * refetch the instant it renders.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/** jotai doesn't re-export a `Store` type from its package root at this version — derive it instead. */
type JotaiStore = ReturnType<typeof createStore>;

// ---------------------------------------------------------------------------
// Session (signed-in / signed-out)
// ---------------------------------------------------------------------------

export interface TestSessionUser {
  id: string;
  name: string;
  username?: string | null;
  displayUsername?: string | null;
  image?: string | null;
}

interface TestSessionValue {
  data: { user: TestSessionUser } | null;
  isPending: boolean;
  error: null;
}

/**
 * `atoms/session.ts` seeds `sessionAtom` from `sessionStore.get()` and then
 * re-syncs it from `sessionStore.subscribe` the instant anything mounts the
 * atom — nanostores' `subscribe` calls its listener immediately with the
 * current value, by design (see that file's comment on avoiding a
 * null-then-real-value flash). That immediate re-sync is exactly why
 * `store.set(sessionAtom, ...)` on a test store doesn't stick: the next
 * mount overwrites it with whatever the real nanostore currently holds.
 * Mocking `sessionStore` itself is the only lever that actually reaches the
 * atom, so this is a module mock, not a store write.
 */
let currentSession: TestSessionValue = { data: null, isPending: false, error: null };
const sessionListeners = new Set<(value: TestSessionValue) => void>();

vi.mock("@/lib/auth-client", () => ({
  sessionStore: {
    get: () => currentSession,
    subscribe: (listener: (value: TestSessionValue) => void) => {
      sessionListeners.add(listener);
      listener(currentSession); // mirrors nanostores' "fire immediately" contract
      return () => sessionListeners.delete(listener);
    },
  },
  // Nothing under test in src/components imports these directly (they only
  // reach `sessionStore` through src/atoms/session.ts), but they're stubbed
  // so an incidental transitive import of the real module's other exports
  // doesn't crash instead of just going unused.
  authClient: {},
  useSession: () => currentSession,
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
}));

/**
 * jsdom doesn't implement `window.scrollTo`, and TanStack Router's
 * scroll-restoration listener is registered unconditionally on every router
 * (not gated behind the `scrollRestoration` option, which only controls
 * whether a *previous* position is restored — the reset-to-top scroll on
 * every navigation fires regardless). Left unstubbed, jsdom's
 * "not implemented" surfaces inside a passive effect during commit, which
 * React has no error boundary to catch here, and the whole render aborts —
 * RTL ends up looking at an empty `<div/>` with no indication why.
 */
// jsdom *does* define `window.scrollTo` — as a stub that reports "not
// implemented" when called — so a `typeof` check wouldn't catch it. Just
// replace it outright.
window.scrollTo = () => {};

function setTestSession(next: TestSessionValue): void {
  currentSession = next;
  sessionListeners.forEach((listener) => listener(currentSession));
}

function signedOutSession(): TestSessionValue {
  return { data: null, isPending: false, error: null };
}

function signedInSession(user: Partial<TestSessionUser> = {}): TestSessionValue {
  return {
    data: {
      user: {
        id: crypto.randomUUID(),
        name: "Alex Mercer",
        username: "alexmercer",
        displayUsername: "AlexMercer",
        image: null,
        ...user,
      },
    },
    isPending: false,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * A minimal stand-in for `routeTree.gen.ts`, covering every path a component
 * under test can `<Link>` or `navigate()` to. The component under test is
 * mounted inside the root route's component, next to an `<Outlet/>` — one
 * render, kept mounted through every navigation a test triggers, exactly
 * like `__root.tsx` keeps Header/Footer mounted while only the routed page
 * changes underneath. That gives a test two independent ways to confirm a
 * navigation happened: `router.state.location.pathname`, or the target
 * route's marker appearing via the outlet.
 */
function createTestRouteTree(ui: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {ui}
        <Outlet />
      </>
    ),
  });

  const stubRoute = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => <p>Stub route: {path}</p>,
    });

  return rootRoute.addChildren([
    stubRoute("/"),
    stubRoute("/login"),
    stubRoute("/register"),
    stubRoute("/discover"),
    stubRoute("/post/$postId"),
    // Literal-prefix syntax — kept byte-identical to src/routes/@{$username}.tsx.
    stubRoute("/@{$username}"),
  ]);
}

function buildTestRouter(ui: ReactNode, initialPath: string) {
  return createRouter({
    routeTree: createTestRouteTree(ui),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

// ---------------------------------------------------------------------------
// renderWithProviders
// ---------------------------------------------------------------------------

export interface RenderWithProvidersOptions {
  /** Fresh by default. Pass one you built yourself to inspect/seed atoms before asserting. */
  store?: JotaiStore;
  /** Fresh by default. Pass one you built yourself to seed the query cache before render. */
  queryClient?: QueryClient;
  /** Where the memory router starts. Defaults to "/". */
  initialPath?: string;
  /**
   * `false` (default): signed out. `true`: a generic signed-in viewer.
   * An object: signed in as a viewer with these fields.
   */
  signedInAs?: boolean | Partial<TestSessionUser>;
}

export interface RenderWithProvidersResult extends RenderResult {
  store: JotaiStore;
  queryClient: QueryClient;
  router: ReturnType<typeof buildTestRouter>;
}

export async function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): Promise<RenderWithProvidersResult> {
  const {
    store = createStore(),
    queryClient = createTestQueryClient(),
    initialPath = "/",
    signedInAs = false,
  } = options;

  // Mirrors src/lib/store.ts: queryClientAtom must be hydrated before
  // anything reads it, or jotai locks in its own default QueryClient and
  // every atom-driven query silently talks to a client nothing renders with.
  store.set(queryClientAtom, queryClient);

  setTestSession(
    signedInAs === false ? signedOutSession() : signedInSession(signedInAs === true ? {} : signedInAs),
  );

  const router = buildTestRouter(ui, initialPath);

  const result = render(
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Provider>,
  );

  // `RouterProvider` resolves its initial match asynchronously even with no
  // loaders anywhere in the stub tree — without awaiting it, the first
  // synchronous paint is empty and every query in a test would be racing an
  // unresolved promise. TanStack Router's own test suite awaits the same
  // thing (render, then await the initial load) rather than asserting
  // straight after `render()`.
  await act(async () => {
    await router.load();
  });

  return { ...result, store, queryClient, router };
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function makeAuthor(overrides: Partial<Post["author"]> = {}): Post["author"] {
  return {
    id: crypto.randomUUID(),
    name: "Alex Mercer",
    username: "alexmercer",
    displayUsername: "AlexMercer",
    image: null,
    ...overrides,
  };
}

export function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: crypto.randomUUID(),
    content: "Hello, world!",
    createdAt: new Date(),
    parentId: null,
    author: makeAuthor(),
    likeCount: 0,
    replyCount: 0,
    viewerHasLiked: false,
    ...overrides,
  };
}

export function makeUserSummary(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    id: crypto.randomUUID(),
    name: "Jamie Rivera",
    username: "jamierivera",
    displayUsername: "JamieRivera",
    image: null,
    createdAt: new Date(),
    followedAt: new Date(),
    viewerIsFollowing: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Infinite-query cache seeding
//
// `post.list` and `user.followers`/`user.following` are keyset-paginated
// (see CLAUDE.md) behind `atomWithInfiniteQuery`. There's no server in this
// test environment, so a component that finds nothing cached will actually
// try to `fetch()` — a real, slow, environment-dependent network call.
// Seeding the exact query key `setQueryData`/`fetchInfiniteQuery` bypasses
// that entirely: `refetchOnMount: false` above means a query that already
// has data (or has already been driven to an error state) is left alone
// when the real observer mounts, instead of being refetched over it.
// ---------------------------------------------------------------------------

/**
 * The exact queryKey `postFeedAtom({ feed: "global" })` produces — mirrors
 * the conditional-spread input builder in `atoms/post-feed.ts`'s
 * `postFeedFamily` for the no-authorId/no-parentId/global-feed case, which
 * is the only shape `post-feed.test.tsx` needs. CLAUDE.md calls that
 * conditional-spread shape load-bearing (oRPC embeds the whole input object
 * in the key, so an unconditional field forks the cache); if that atom's
 * input shape ever changes, this needs the matching update.
 */
export function postListQueryKey(): QueryKey {
  return orpc.post.list.infiniteKey({
    input: () => ({ limit: POST_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
  });
}

export function seedPostListPages(queryClient: QueryClient, pages: PostListPage[]): void {
  queryClient.setQueryData(postListQueryKey(), {
    pages,
    pageParams: pages.map((_page, index) => (index === 0 ? undefined : (pages[index - 1]?.nextCursor ?? undefined))),
  });
}

/** The exact queryKey `userListAtom(username, direction)` produces. */
export function userListQueryKey(username: string, direction: "followers" | "following"): QueryKey {
  const procedure = direction === "followers" ? orpc.user.followers : orpc.user.following;
  return procedure.infiniteKey({
    input: () => ({ username, limit: FOLLOW_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
  });
}

export function seedUserListPages(
  queryClient: QueryClient,
  username: string,
  direction: "followers" | "following",
  pages: UserListPage[],
): void {
  queryClient.setQueryData(userListQueryKey(username, direction), {
    pages,
    pageParams: pages.map((_page, index) => (index === 0 ? undefined : (pages[index - 1]?.nextCursor ?? undefined))),
  });
}

/** Drives an infinite query at `queryKey` into a permanent loading state, without a network call. */
export function seedInfiniteLoading(queryClient: QueryClient, queryKey: QueryKey): void {
  void queryClient.fetchInfiniteQuery({
    queryKey,
    queryFn: () => new Promise<never>(() => {}),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: () => undefined,
  });
}

/** Drives an infinite query at `queryKey` into an error state, without a network call. */
export function seedInfiniteError(queryClient: QueryClient, queryKey: QueryKey, message = "Something went wrong"): void {
  void queryClient
    .fetchInfiniteQuery({
      queryKey,
      queryFn: () => Promise.reject(new Error(message)),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: () => undefined,
    })
    .catch(() => {
      // The rejection is the point: it lands the query in an `error` state
      // in the cache before the component under test mounts an observer.
      // Nothing here needs to see it again.
    });
}
