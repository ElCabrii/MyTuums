# Tests to rewrite

> **Temporary file.** This exists only to make the Jotai-migration test rewrite faithful to what
> was deleted in commit 1 of the `feat/jotai-atoms` migration. Delete this file once all five
> suites below are rewritten against the new `createStore()` + `<Provider store>` harness.

Five suites were deleted because they all `vi.mock("@/lib/auth-client")` to control session state,
and the session-atom migration (commit 5 of the plan) makes that mock inert — session moves to a
Jotai atom bridged off BetterAuth's nanostore, so mocking the `useSession` hook module no longer
controls what components actually read. 59 tests total.

`apps/web/src/lib/format.test.ts` and `apps/web/src/lib/user.test.ts` are **not** part of this —
they test pure functions untouched by the migration and were kept.

---

## home-page.test.tsx

**Component under test:** `HomePage` (`./home-page.tsx`).

**Mocking setup:**

```ts
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
```

Render helper — a **fresh Jotai store per render** so a scope set/clicked in one test can't leak
into the next:

```ts
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
```

```ts
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
```

Fixture shape: `{ user: { id: "viewer-1", name: "Viewer", image: null } }`.

**Tests** (`describe("home feed scope")`, 10):

1. **defaults a signed-in visitor to the For you (global) feed** — signed-in, no stored scope; asserts the first `post.list` call's input has no `feed` key.
2. **shows a signed-out visitor the global feed** — no session; asserts no `feed` key.
3. **ignores a remembered Following choice for a signed-out visitor** — store seeded `scope: "following"` but no session; asserts still no `feed` key (server would reject it from a signed-out caller).
4. **honours a remembered Following choice for a signed-in visitor** — signed-in + stored `"following"`; asserts input matches `{ feed: "following" }`.
5. **falls back to the global feed when the stored value is garbage** — `localStorage["my-tuums.feed-scope"] = JSON.stringify("nonsense")`, signed-in; asserts no `feed` key.
6. **waits for the session before requesting anything** — `sessionMock.pending = true`; asserts `post.list` is never called (no fetch-then-refetch flash once the session resolves).
7. **offers the feed switch only when signed in** — signed-out; asserts no "Following" button and the global-feed copy ("latest from everyone") instead.
8. **marks the selected feed tab** — signed-in, default scope; asserts "For you" has `aria-pressed="true"`, "Following" has `"false"`.
9. **switches the feed on click and remembers the choice** — signed-in, click "Following"; asserts the button becomes pressed, `post.list` last called with `feed: "following"`, the store's `feedScopeAtom` is now `"following"`, and `localStorage` holds `JSON.stringify("following")`.
10. **points people at /discover when the Following feed is empty** — signed-in + scope "following", empty result; asserts empty copy ("you're not following anyone who's posted") and a link with `href="/discover"`.

---

## profile-page.test.tsx

**Components under test:** `ProfileLayout` (`./profile-layout.tsx`) and `ProfilePosts`
(`./profile-posts.tsx`), rendered as siblings — mirrors what the router composes at
`/@alexmercer` once `<Outlet />` resolves.

**Mocking setup:**

```ts
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

const { paramsMock } = vi.hoisted(() => ({
  paramsMock: { current: { username: "alexmercer" } },
}));

vi.mock("@tanstack/react-router", () => ({
  // Both the layout and the Posts tab call `getRouteApi(id).useParams()` with
  // their own route id; the mock ignores the id, same as the real Route
  // registry does per-file, since both read from the same param set here.
  getRouteApi: () => ({
    useParams: () => paramsMock.current,
  }),
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  // The layout's children are exercised by rendering them alongside it below,
  // so the outlet itself only needs to not blow up.
  Outlet: () => null,
}));
```

Fixtures:

```ts
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

const FOLLOWER = {
  id: "follower-1",
  name: "Sam Vega",
  username: "samvega",
  displayUsername: "SamVega",
  image: null,
  createdAt: new Date(2026, 6, 1),
  followedAt: new Date(2026, 7, 20),
  viewerIsFollowing: false,
};
```

Render helper:

```ts
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
```

```ts
beforeEach(() => {
  vi.clearAllMocks();
  paramsMock.current = { username: "alexmercer" };
  sessionMock.current = null;
  clientMock.post.list.mockResolvedValue({ items: [], nextCursor: null });
  clientMock.user.byUsername.mockResolvedValue(PROFILE);
  clientMock.user.followers.mockResolvedValue({ items: [FOLLOWER], nextCursor: null });
  clientMock.user.following.mockResolvedValue({ items: [], nextCursor: null });
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
```

**Tests, `describe("profile page")`** (9):

1. **renders a stranger's profile from the handle in the URL** — asserts heading "Alex Mercer", `@AlexMercer` displayUsername text, "Joined August 2026", and `byUsername` called with `{ username: "alexmercer" }`.
2. **loads that person's posts, not the signed-in user's** — signed-in as `viewer-9`; asserts `post.list` called with `authorId: "author-1"`, not the viewer's id.
3. **keeps the owner's controls off someone else's profile** — signed-in as `viewer-9`; asserts no "sign out"/"edit profile"/"post" (composer) buttons, and the not-mine empty-posts copy ("@alexmercer hasn't posted anything yet").
4. **never shows another person's email address** — signed-in as `viewer-9`; asserts `viewer@example.com` is not shown anywhere (public `byUsername` never returns email; the page must not leak the *viewer's own* email onto someone else's profile either).
5. **shows the owner their controls and their own email** — signed-in as `author-1`; asserts "sign out"/"edit profile" present, `alex@example.com` shown, and the owner's empty-posts copy ("you haven't posted anything yet").
6. **resolves the profile whatever case the handle is typed in** — `paramsMock` username `"AlexMercer"` (mixed case); asserts `byUsername` called with the literally-typed casing (normalization is the server's job, the client passes it through unmodified).
7. **says the handle is free when nobody has it** — `byUsername` rejects `ORPCError("NOT_FOUND")`; asserts "this handle isn't taken" copy and heading `@nobodyhome`.
8. **does not retry a handle the server said does not exist** — same 404; asserts `byUsername` called exactly once.
9. **offers a retry when the failure might be transient** — generic `Error("network is down")` (not an `ORPCError`); asserts "couldn't load this profile" copy, a "try again" button, and `byUsername` called more than once.

**`describe("profile follow graph")`** (7):

1. **shows follower and following counts, compacted, as list buttons** — asserts "followers" reads "1.2K", "following" reads "42".
2. **singularises a lone follower** — `followerCount: 1`; asserts text matches `/1 follower$/i` (no trailing s).
3. **offers a Follow button on someone else's profile** — signed-in as `viewer-9`; asserts a "Follow" button exists.
4. **does not offer a Follow button on your own profile** — signed-in as `author-1`; asserts no "Follow" button.
5. **sends a signed-out visitor to log in rather than into a 401** — no session; asserts the Follow control (a `Button nativeButton={false}` rendering as a link) has `href="/login"` and `user.follow` never called.
6. **flips the button and bumps the count optimistically** — signed-in as `viewer-9`, click Follow; asserts button becomes "Unfollow", followers count still reads "1.2K" (1235 compacts the same as 1234), and `user.follow` called with `{ userId: "author-1" }`.
7. **rolls the button back when the follow fails** — `user.follow` rejects; after clicking Follow, asserts the button reverts to "Follow".

**`describe("profile follow lists")`** (4):

1. **opens the followers list in a dialog** — click "followers"; asserts a dialog headed "Followers" containing "Sam Vega", `user.followers` called with `{ username: "alexmercer", ... }`, and `user.following` **not** called.
2. **opens the following list from the other count** — click "following"; asserts dialog headed "Following", empty copy ("isn't following anyone yet"), and `user.followers` not called.
3. **does not fetch either list until one is opened** — plain render; asserts no dialog and neither `followers` nor `following` called (lists mount lazily inside their dialog).
4. **closes the dialog again** — open followers dialog, click "Close"; asserts the dialog is eventually removed from the DOM.

---

## post-feed.test.tsx

**Component under test:** `PostFeed` (`./post-feed.tsx`).

File-header rationale (quote — explains a constraint the rewrite must also honour):

```
// The oRPC client is replaced wholesale, and `orpc` is rebuilt from the fake
// with the real `createTanstackQueryUtils`. That keeps the query keys, the
// infinite-query plumbing and the mutation options exactly as they are in the
// app — the part under test is how the cache is updated, and swapping the key
// factory for a hand-written one would test a different program.
```

**Mocking setup:**

```ts
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
```

Fixture factory:

```ts
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
```

`deferred<T>()`: a manually resolvable/rejectable promise, used to hold a mutation "in flight" so
an intermediate optimistic state can be asserted before the request settles.

**Tests, `describe("PostFeed")`** (6 top-level):

1. **renders a post with its author and like count** — asserts author name/handle, content, like button `aria-pressed="false"`, count "3".
2. **shows the empty state when there is nothing to show** — empty items; asserts `emptyMessage` renders.
3. **renders an emptyAction alongside the empty message** — empty items + `emptyAction` prop; asserts the passed link ("Find people") renders too.
4. **omits feed entirely for the global timeline** — default (no `feed` prop); asserts `post.list`'s input object does NOT contain a `feed` key at all.
5. **sends feed: following when scoped to the follow graph** — `<PostFeed feed="following">`; asserts input has `feed: "following"`.
6. **surfaces a failed load with a retry** — `post.list` rejects; asserts an alert with the error message and a "try again" button.

**`describe("liking")`** (nested, 8):

1. **updates the count before the request comes back** — `post.like` held via `deferred`; while unresolved, asserts the call fired with `{ postId: "post-1" }`, count is optimistically "4", button reads "unlike" with `aria-pressed="true"`.
2. **takes the authoritative count from the response** — `post.like` resolves with `likeCount: 9` (simulating a concurrent liker); asserts the button eventually shows "9" — server truth overrides the optimistic `+1` guess.
3. **puts the count back when the request fails** — `post.like` rejects; asserts full rollback to unliked/"3".
4. **unlikes a post the viewer already liked** — start `viewerHasLiked: true, likeCount: 3`, click unlike; asserts it becomes unliked and only `unlike` (not `like`) was called.
5. **ends up unliked when a like is immediately undone** — regression test. Both `like` and `unlike` held on separate deferreds. Click like (optimistic 4) → immediately click unlike (optimistic drops back to 3 *before* the unlike request even starts, since it's queued behind the pending like) → resolve the now-stale `like` response (`likeCount: 4, viewerHasLiked: true`) and assert the UI does **not** reconcile back to liked from it → resolve `unlike` and assert it stays unliked/3.
6. **serialises requests so the server sees the clicks in order** — click like then unlike while `like` is held; asserts `unlike`'s call has not fired yet (`order` only holds `"like"`); only after the held `like` resolves does `"unlike"` get pushed.
7. **settles on the last click after a burst** — three rapid clicks (like, unlike, like), each resolving immediately; asserts final state is liked, `like` called twice and `unlike` once — every click still issues its own request, just serialized.
8. **sends signed-out viewers to log in instead of firing a request** — `sessionMock.current = null`; asserts no like *button* role is rendered (a titled link to `/login` instead) and `post.like` never called.

---

## post-composer.test.tsx

**Component under test:** `PostComposer` (`./post-composer.tsx`).

**Mocking setup:**

```ts
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
  } = { current: { user: { id: "viewer-1", name: "Alex Mercer", image: null } } };
  return { sessionMock };
});

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: sessionMock.current, isPending: false }),
}));
```

Note: unlike the other four suites, this mock does **not** stub `authClient.signOut` — the
composer never calls it.

Imports the real `POST_MAX_LENGTH` from `@my-tuums/api/constants` (not mocked) — the length-limit
tests are exact against this constant, never a hardcoded number.

**Tests, `describe("PostComposer")`** (7):

1. **renders nothing for a signed-out visitor** — `sessionMock.current = null`; asserts the container is completely empty (`toBeEmptyDOMElement`), not merely hidden/disabled.
2. **counts down the characters left** — asserts the counter starts at `POST_MAX_LENGTH`, drops to `POST_MAX_LENGTH - 5` after typing "hello".
3. **won't submit an empty or whitespace-only post** — disabled initially, still disabled after only spaces, enabled after one non-space char.
4. **won't submit past the length limit** — pastes `POST_MAX_LENGTH + 1` chars via `paste` (not `type`, to avoid one keystroke event per character); asserts counter shows "-1", submit stays disabled, `post.create` never called.
5. **sends the trimmed content and clears the box** — types `"  first light  "`, submits; asserts `post.create` called with `{ content: "first light" }` (trimmed) and the textarea clears.
6. **refetches the feeds so the new post appears in them** — spies `queryClient.invalidateQueries`; asserts it's called after a successful submit.
7. **keeps the draft and explains itself when publishing fails** — `post.create` rejects `Error("server said no")`; asserts an alert with that message AND the exact untrimmed typed text remains in the textarea.

---

## user-list.test.tsx

**Component under test:** `UserList` (`./user-list.tsx`).

**Mocking setup:**

```ts
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
```

Fixture factory:

```ts
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
```

Render helper takes a direction:

```ts
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
```

> **Pre-existing oddity, not a migration concern — but worth checking in the rewrite:** test 1
> below asserts `toHaveAttribute("href", "/@{$username}")`, the literal unrendered route-template
> string, not a resolved handle like `/@alexmercer`. The mocked `Link` just echoes whatever `to`
> it receives, so this suggests the real `to` prop (or the mock, upstream) isn't interpolating the
> param. Re-verify against the live component rather than porting the assertion unexamined.

**Tests, `describe("UserList")`** (8):

1. **lists people and links each to their profile** — asserts the row shows "Alex Mercer" and a profile link (see oddity note above), and `user.followers` called with `{ username: "targetuser", ... }`.
2. **calls the procedure matching the direction** — `direction="following"`; asserts `user.following` called and `user.followers` **not** called.
3. **shows the empty message when there is nobody** — empty items; asserts "Nobody here yet." renders.
4. **carries a working follow control on each row** — click "Follow"; asserts it becomes "Unfollow" and `user.follow` called with `{ userId: "user-1" }`.
5. **reflects a row the viewer already follows** — `viewerIsFollowing: true`; asserts the row starts as "Unfollow".
6. **omits the follow control on the viewer's own row** — row `id: "viewer-1"` (== signed-in viewer); asserts no "Follow" button on that row.
7. **pages on demand** — first page returns `nextCursor: "cursor-2"`, click "load more"; asserts the second page's user ("Sam Vega") appears and the next call carries `{ cursor: "cursor-2", ... }`.
8. **offers a retry when the list fails to load** — `user.followers` rejects; asserts an alert and a "try again" button.

---

## Invariants that must not be lost

These are the tests whose *reason* matters more than their mechanics — port the assertion, but
keep the comment/rationale too, since a future reader (or a future refactor) needs to know *why*
the assertion exists, not just that it passes.

- **`feed` is deliberately ABSENT from the query input for the global timeline — never `"global"`.**
  (home-page: "shows a signed-out visitor the global feed", "defaults a signed-in visitor...";
  post-feed: "omits feed entirely for the global timeline"). The conditional spread keeps the
  global timeline's query key/cache byte-identical to what it was before the Following feature —
  an explicit `feed: "global"` forks the cache and breaks the `orpc.post.list.key()` prefix sweeps
  the like mutation depends on. (See migration plan, commit 7: "Preserve the conditional spreads
  in `infiniteOptions` verbatim.")
- **A signed-out visitor's remembered `"following"` scope is overridden when requesting, not
  cleared from storage.** (home-page: "ignores a remembered Following choice for a signed-out
  visitor"). The stored value survives untouched in `localStorage`; only what's requested changes,
  because the server would reject `feed: "following"` from an unauthenticated caller.
- **The home feed must not request anything while the session is still pending**, or it fires
  the global-feed request and then flips to Following a tick later, firing a second request.
  (home-page: "waits for the session before requesting anything".)
- **A garbage/hand-edited `localStorage` scope value must fall back to the global feed**, not
  throw or apply nonsense — localStorage is user-editable and outlives deploys. (home-page:
  "falls back to the global feed when the stored value is garbage".)
- **The profile query must not retry a definitive 404, but must retry an ambiguous/network
  error.** (profile-page: "does not retry a handle the server said does not exist" vs "offers a
  retry when the failure might be transient".) This is `retryUnlessClientError`; the suite
  deliberately pulls in the *real* implementation via `vi.importActual` rather than stubbing it,
  because the predicate itself is under test.
- **`user.byUsername` never leaks `email`; the page shows the viewer's OWN email only on their
  own profile.** (profile-page: "never shows another person's email address", "shows the owner
  their controls and their own email".) This is the UI half of the deliberate column-allowlist on
  the server — CLAUDE.md calls it out explicitly: "Widen it deliberately — there is a test
  guarding it."
- **Handle lookups pass the URL param through unmodified** — normalization is the server's job.
  (profile-page: "resolves the profile whatever case the handle is typed in", asserting
  `byUsername` is called with the literally-typed casing.)
- **Follower/following lists are lazy** — mounted, and fetched, only while their own dialog is
  open; opening one never fetches the other. (profile-page: "does not fetch either list until one
  is opened", plus the "not called" assertions in both "opens the ... list" tests.)
- **A signed-out visitor is sent to log in, never allowed to fire a request that's guaranteed to
  401.** (profile-page: "sends a signed-out visitor to log in rather than into a 401"; post-feed:
  "sends signed-out viewers to log in instead of firing a request".) Both assert the mutation
  function itself is never invoked.
- **Like/unlike on the same post are serialized, and a stale in-flight response must NOT
  overwrite a newer optimistic state.** (post-feed "liking" block, especially "ends up unliked
  when a like is immediately undone" and "serialises requests so the server sees the clicks in
  order".) This is the single most load-bearing test being deleted — it's the regression the
  mutation-scoping design (and the migration plan's commit-2 "scoping gate") exists to prevent.
  The rewrite MUST keep a test that (a) holds two opposing mutations on deferred promises, (b)
  proves the second doesn't start until the first settles, and (c) proves resolving the first
  (now-stale) response after the second is already queued does not flip the UI back.
- **The optimistic count is provisional; the server's returned count is authoritative** and can
  differ from `optimistic ± 1`. (post-feed: "takes the authoritative count from the response",
  server returns `likeCount: 9` against an optimistic guess of 4.)
- **Failed optimistic mutations roll back fully**, not just "don't crash". (profile-page: "rolls
  the button back when the follow fails"; post-feed: "puts the count back when the request
  fails".)
- **The composer trims content before sending, but must not lose the untrimmed draft on
  failure.** (post-composer: "sends the trimmed content and clears the box" vs "keeps the draft
  and explains itself when publishing fails" — the latter asserts the exact untrimmed text
  survives a failed submit.)
- **A signed-out visitor gets literally nothing from `PostComposer`** — `toBeEmptyDOMElement`,
  not an invisible/disabled form. (post-composer: "renders nothing for a signed-out visitor".)
- **A list row never offers a follow control for the viewer's own entry**, mirroring the same
  rule on the profile header. (user-list: "omits the follow control on the viewer's own row";
  profile-page: "does not offer a Follow button on your own profile".)
- **Pagination is cursor-driven, not offset-based**, and on-demand. (user-list: "pages on
  demand" — the second request explicitly carries `cursor: "cursor-2"` taken from the prior
  page's `nextCursor`.)
