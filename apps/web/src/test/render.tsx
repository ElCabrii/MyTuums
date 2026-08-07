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
import { FOLLOW_PAGE_SIZE, POST_PAGE_SIZE, SEARCH_PAGE_SIZE } from "@my-tuums/api/constants";
import {
  orpc,
  type Post,
  type PostListPage,
  type SearchPostsPage,
  type SearchUsersPage,
  type UserListPage,
  type UserSummary,
} from "@/lib/orpc";

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
 * `refetchOnMount: false` so a query that already has data seeded via
 * `queryClient.setQueryData` stays exactly as seeded when a component mounts
 * and observes it, instead of firing a real (network-dependent,
 * unmockable-without-a-lot-of-effort) background refetch the instant it
 * renders.
 *
 * `retryOnMount: false` is the one that actually matters for a SEEDED ERROR
 * specifically, and is easy to miss: `refetchOnMount` only governs refetching
 * a query that has previously *succeeded* (`dataUpdatedAt > 0`). A query
 * that has only ever errored has `dataUpdatedAt === 0`, and TanStack Query's
 * own mount-fetch decision treats that case as "never actually got data yet"
 * — it fetches on mount REGARDLESS of `refetchOnMount`, unless
 * `retryOnMount` says not to. Without this, `PostFeed`'s/`UserList`'s
 * observer mounting against a query `seedInfiniteError` already drove to
 * "error" immediately fires one more real (and here, doomed) network fetch,
 * landing back on "error" but with a generic "fetch failed" message instead
 * of the one that was seeded — confirmed by instrumenting the actual `Query`
 * instance: neither `.reset()` nor `.setState()` fired, only `.fetch()`.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        retryOnMount: false,
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
  /** A Date, as the session store reports it. Omit it to simulate a session that never declared one. */
  dateOfBirth?: Date | null;
  bio?: string | null;
  bannerImage?: string | null;
  /**
   * The account's stored defaults. Null in the default fixture, which is the
   * "never chose" state `atoms/theme.ts` and `atoms/locale.ts` fall back from —
   * pass one to exercise the fallback actually applying.
   */
  themePreference?: string | null;
  localePreference?: string | null;
  /** Read by `/settings/account`'s two-factor section to decide on/off. */
  twoFactorEnabled?: boolean | null;
}

interface TestSessionValue {
  data: { user: TestSessionUser } | null;
  isPending: boolean;
  isRefetching: boolean;
  /**
   * The last settled failure, when there was one. Only `.status` is read —
   * `sessionErrorAtom` feeds the signed-in gate's 401 carve-out. Null until a
   * fetch settles on an error, which is what every fixture ships.
   */
  error: { status: number } | null;
  /** The store value's own refetch — what `lib/session-sync.ts`'s `refreshSession` calls. */
  refetch: (queryParams?: unknown) => Promise<void>;
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
// Starts PENDING, matching BetterAuth's real session store's cold-start value
// (`session-atom.mjs` seeds `{ data: null, isPending: true }`). This is what
// makes the signed-in gate's cold-load guard testable: the atom's initial
// value — captured at module import — is what the first render sees, and if it
// read "resolved signed-out" here, a signed-in/pending test would redirect
// before the immediate-fire subscription below delivers the real value. The
// same trap is documented in `session.test.ts`.
let currentSession: TestSessionValue = {
  data: null,
  isPending: true,
  isRefetching: false,
  error: null,
  refetch: vi.fn(() => Promise.resolve()),
};
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
  /**
   * The full client surface the auth atoms reach for.
   *
   * This used to be `{}`, which was fine while only `atoms/session.ts` went
   * through this module — it reads `sessionStore` and nothing else. The auth
   * hardening changed that: `atoms/auth.ts`, `atoms/two-factor.ts`,
   * `atoms/passkey.ts`, `atoms/handle-claim.ts` and `atoms/linked-accounts.ts`
   * all call `authClient.*` namespaces directly, and an empty object turns any
   * component that renders one of them into a "cannot read properties of
   * undefined" at call time rather than a readable failure.
   *
   * Every stub resolves `{ data, error }` rather than rejecting, matching how
   * BetterAuth's client actually reports failure. A test that cares overrides
   * the specific one with `vi.mocked(...).mockResolvedValue(...)`.
   */
  authClient: {
    signIn: {
      email: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      username: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      social: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      passkey: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    },
    signUp: { email: vi.fn(() => Promise.resolve({ data: {}, error: null })) },
    signOut: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    requestPasswordReset: vi.fn(() =>
      Promise.resolve({ data: { status: true }, error: null }),
    ),
    resetPassword: vi.fn(() => Promise.resolve({ data: { status: true }, error: null })),
    updateUser: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    // `/settings/account`'s password section. Like every other namespace here,
    // its absence would be a "cannot read properties of undefined" at click
    // time rather than a type error.
    changePassword: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    listAccounts: vi.fn(() => Promise.resolve({ data: [], error: null })),
    linkSocial: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    unlinkAccount: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    twoFactor: {
      enable: vi.fn(() => Promise.resolve({ data: { totpURI: "", backupCodes: [] }, error: null })),
      disable: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      verifyTotp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      verifyOtp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      verifyBackupCode: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      sendOtp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    },
    passkey: {
      addPasskey: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      listUserPasskeys: vi.fn(() => Promise.resolve({ data: [], error: null })),
      updatePasskey: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      deletePasskey: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    },
    getLastUsedLoginMethod: vi.fn(() => null),
  },
  useSession: () => currentSession,
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  // Read at module scope by `lib/one-tap.ts` and by `sign-in-options.tsx`;
  // off by default so component tests don't render provider buttons unless
  // they mean to.
  shouldOfferOneTap: false,
  socialProviders: [],
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

/**
 * Pushes a value into the mocked session store and notifies every subscriber
 * — how a test drives a session change mid-render, mirroring a live
 * `/get-session` settling.
 */
export function setTestSession(next: TestSessionValue): void {
  currentSession = next;
  sessionListeners.forEach((listener) => listener(currentSession));
}

function signedOutSession(): TestSessionValue {
  return {
    data: null,
    isPending: false,
    isRefetching: false,
    error: null,
    refetch: vi.fn(() => Promise.resolve()),
  };
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
        // The editable profile and the stored preferences, all unset — the
        // state a fresh account is in, and the one the theme/locale fallbacks
        // in atoms/theme.ts and atoms/locale.ts are written against. A test
        // that wants a stored preference passes it through `signedInAs`.
        bio: null,
        bannerImage: null,
        themePreference: null,
        localePreference: null,
        // A complete sign-up by default — the state components assume when
        // they render a generic signed-in viewer. Omit it (or set username
        // null) to build an incomplete session on purpose.
        dateOfBirth: new Date("1995-01-01T00:00:00.000Z"),
        ...user,
      },
    },
    isPending: false,
    isRefetching: false,
    error: null,
    refetch: vi.fn(() => Promise.resolve()),
  };
}

function pendingSession(): TestSessionValue {
  // The cold-load state: BetterAuth's first /get-session still in flight.
  // `sessionPendingAtom` reads true and `isSignedInAtom` reads false — the
  // exact combination the signed-in gate must not redirect on.
  return {
    data: null,
    isPending: true,
    isRefetching: false,
    error: null,
    refetch: vi.fn(() => Promise.resolve()),
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
    // Signed-in-gate exemptions like the legal pages below — tests for the
    // gate need them reachable without a redirect.
    stubRoute("/forgot-password"),
    stubRoute("/reset-password"),
    stubRoute("/discover"),
    // search-page.test.tsx navigates the real `SearchPage` between `/search`
    // and `/search?q=...` — `getRouteApi("/search")` needs the route to
    // exist in the tree even though the stub never renders it (the page is
    // mounted directly as `ui`, like the not-found-page test).
    stubRoute("/search"),
    stubRoute("/post/$postId"),
    // The legal pages are signed-in-gate exemptions — tests for the gate
    // need them reachable without a redirect.
    stubRoute("/privacy"),
    stubRoute("/terms"),
    stubRoute("/mentions-legales"),
    // Literal-prefix syntax — kept byte-identical to src/routes/@{$username}.tsx.
    stubRoute("/@{$username}"),
    // Header-test targets: the account menu's View profile / Settings items
    // and the handle-less avatar's /welcome link (header.test.tsx).
    stubRoute("/welcome"),
    stubRoute("/settings/account"),
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
  /**
   * `true`: the cold-load state — session in flight, reads as signed out for
   * one tick. The signed-in gate must NOT redirect on this.
   */
  sessionPending?: boolean;
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
    sessionPending = false,
  } = options;

  // Mirrors src/lib/store.ts: queryClientAtom must be hydrated before
  // anything reads it, or jotai locks in its own default QueryClient and
  // every atom-driven query silently talks to a client nothing renders with.
  store.set(queryClientAtom, queryClient);

  setTestSession(
    sessionPending
      ? pendingSession()
      : signedInAs === false
        ? signedOutSession()
        : signedInSession(signedInAs === true ? {} : signedInAs),
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

/** A minimal post author for fixtures. */
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

/** A minimal post for fixtures. */
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
    // The tombstone fields (issue #38): never removed by default — the stub
    // branch in post-card owns the removed fixtures.
    removed: false,
    removedReason: null,
    ...overrides,
  };
}

/** A minimal follower/following list entry for fixtures. */
export function makeUserSummary(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    id: crypto.randomUUID(),
    name: "Jamie Rivera",
    username: "jamierivera",
    displayUsername: "JamieRivera",
    image: null,
    bio: null,
    bannerImage: null,
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

/** Seeds a `post.list` infinite query with the given pages, bypassing the network. */
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

/**
 * The exact queryKey `searchUsersAtom(q)` produces — mirrors the input
 * builder in `atoms/search.ts`'s `searchUsersFamily` for the first page (no
 * cursor). `q` is embedded in the key, so the seed only satisfies the
 * section for that one query string.
 */
export function searchUsersQueryKey(q: string): QueryKey {
  return orpc.search.users.infiniteKey({
    input: () => ({ q, limit: SEARCH_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
  });
}

/** The exact queryKey `searchPostsAtom(q)` produces — the `posts` twin of {@link searchUsersQueryKey}. */
export function searchPostsQueryKey(q: string): QueryKey {
  return orpc.search.posts.infiniteKey({
    input: () => ({ q, limit: SEARCH_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
  });
}

/** Seeds a `search.users` infinite query with the given pages, bypassing the network. */
export function seedSearchUsersPages(
  queryClient: QueryClient,
  q: string,
  pages: SearchUsersPage[],
): void {
  queryClient.setQueryData(searchUsersQueryKey(q), {
    pages,
    pageParams: pages.map((_page, index) => (index === 0 ? undefined : (pages[index - 1]?.nextCursor ?? undefined))),
  });
}

/** Seeds a `search.posts` infinite query with the given pages, bypassing the network. */
export function seedSearchPostsPages(
  queryClient: QueryClient,
  q: string,
  pages: SearchPostsPage[],
): void {
  queryClient.setQueryData(searchPostsQueryKey(q), {
    pages,
    pageParams: pages.map((_page, index) => (index === 0 ? undefined : (pages[index - 1]?.nextCursor ?? undefined))),
  });
}

/** Seeds a follower/following infinite query with the given pages, bypassing the network. */
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

/**
 * Drives an infinite query at `queryKey` into an error state, without a
 * network call. Callers MUST `await` this — unlike `seedInfiniteLoading`
 * (whose query-core status is set the instant the fetch starts, and which
 * can't be awaited to completion anyway, since it never settles),
 * `fetchInfiniteQuery` here only finishes writing `status: "error"` into the
 * cache once its rejection has propagated through query-core's retry
 * machinery. A caller that renders right after calling this without
 * awaiting it is racing that write: fast enough locally that it reliably
 * wins, not guaranteed on every CI runner — this is exactly the race that
 * intermittently failed `post-feed.test.tsx` and `user-list.test.tsx` in CI
 * while passing every time in local runs.
 */
export async function seedInfiniteError(
  queryClient: QueryClient,
  queryKey: QueryKey,
  message = "Something went wrong",
): Promise<void> {
  try {
    await queryClient.fetchInfiniteQuery({
      queryKey,
      queryFn: () => Promise.reject(new Error(message)),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: () => undefined,
    });
  } catch {
    // The rejection is the point: it lands the query in an `error` state
    // in the cache before the component under test mounts an observer.
    // Nothing here needs to see it again.
  }
}
