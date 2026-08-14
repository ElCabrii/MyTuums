import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";

/**
 * The teardown module imports every atom family it sweeps, and those modules
 * build their query options from `@/lib/orpc` and read the session store at
 * module scope — so both are mocked here, the same way the individual family
 * tests do. The fake client only needs the procedure *groups* to exist so
 * `createTanstackQueryUtils` can build query keys; no procedure is ever
 * invoked, because the test asserts on family identity and cache state, not
 * on fetched data.
 */
const { fakeClient } = vi.hoisted(() => ({
  fakeClient: {
    post: {
      list: vi.fn(),
      thread: vi.fn(),
      create: vi.fn(),
      like: vi.fn(),
      unlike: vi.fn(),
    },
    user: {
      byUsername: vi.fn(),
      followers: vi.fn(),
      following: vi.fn(),
      follow: vi.fn(),
      unfollow: vi.fn(),
    },
    search: { typeahead: vi.fn(), users: vi.fn(), posts: vi.fn() },
    moderation: {
      queue: vi.fn(),
      auditLog: vi.fn(),
      case: vi.fn(),
      team: vi.fn(),
      listBlocked: vi.fn(),
      report: vi.fn(),
      block: vi.fn(),
      unblock: vi.fn(),
      removePost: vi.fn(),
      restorePost: vi.fn(),
      resolve: vi.fn(),
      suspendUser: vi.fn(),
      banUser: vi.fn(),
      unbanUser: vi.fn(),
      setRole: vi.fn(),
      appealOpen: vi.fn(),
      appealReview: vi.fn(),
    },
  },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  const actual = await vi.importActual<typeof import("@/lib/orpc")>("@/lib/orpc");
  return {
    orpc: createTanstackQueryUtils(fakeClient),
    retryUnlessClientError: actual.retryUnlessClientError,
  };
});

// A minimal nanostore-shaped double, exactly as in session.test.ts: the
// teardown's transitive imports include `atoms/session.ts`, which reads
// `sessionStore` at module scope — an absent export would crash the import.
const { state, listeners } = vi.hoisted(() => {
  const initial: { value: unknown } = { value: { data: null, isPending: true } };
  return { state: initial, listeners: new Set<(value: unknown) => void>() };
});

vi.mock("@/lib/auth-client", () => ({
  sessionStore: {
    get: () => state.value,
    subscribe: (listener: (value: unknown) => void) => {
      listeners.add(listener);
      listener(state.value);
      return () => listeners.delete(listener);
    },
  },
}));

import { clearViewerState } from "@/atoms/sign-out-sweep";
import { profileAtomFamily } from "@/atoms/profile";
import { postFeedAtom } from "@/atoms/post-feed";
import { userListAtom } from "@/atoms/user-list";
import { threadAtomFamily } from "@/atoms/thread";
import { replyDraftAtomFamily } from "@/atoms/reply-composer";
import { toggleLikeAtomFamily } from "@/atoms/like";
import { toggleFollowAtomFamily } from "@/atoms/follow";
import { searchUsersAtom, searchPostsAtom } from "@/atoms/search";
import { caseAtom } from "@/atoms/moderation";

function freshStore() {
  const store = createStore();
  store.set(queryClientAtom, new QueryClient());
  return store;
}

describe("clearViewerState", () => {
  it("clears the QueryClient", () => {
    const store = freshStore();
    const queryClient = store.get(queryClientAtom);
    queryClient.setQueryData(["some", "key"], { value: 1 });

    clearViewerState(queryClient);

    expect(queryClient.getQueryData(["some", "key"])).toBeUndefined();
  });

  it("gives every representative atom family a fresh instance afterwards", () => {
    const store = freshStore();
    const queryClient = store.get(queryClientAtom);

    // Seed one entry per family so the sweep has something to remove.
    const profileBefore = profileAtomFamily("alice");
    const feedBefore = postFeedAtom({ feed: "global" });
    const listBefore = userListAtom("alice", "followers");
    const threadBefore = threadAtomFamily("post-1");
    const draftBefore = replyDraftAtomFamily("post-1");
    const likeBefore = toggleLikeAtomFamily("post-1");
    const followBefore = toggleFollowAtomFamily("user-1");
    const searchUsersBefore = searchUsersAtom("hello");
    const searchPostsBefore = searchPostsAtom("hello");
    const caseBefore = caseAtom({ targetType: "post", targetId: "post-1" });

    clearViewerState(queryClient);

    expect(profileAtomFamily("alice")).not.toBe(profileBefore);
    expect(postFeedAtom({ feed: "global" })).not.toBe(feedBefore);
    expect(userListAtom("alice", "followers")).not.toBe(listBefore);
    expect(threadAtomFamily("post-1")).not.toBe(threadBefore);
    expect(replyDraftAtomFamily("post-1")).not.toBe(draftBefore);
    expect(toggleLikeAtomFamily("post-1")).not.toBe(likeBefore);
    expect(toggleFollowAtomFamily("user-1")).not.toBe(followBefore);
    expect(searchUsersAtom("hello")).not.toBe(searchUsersBefore);
    expect(searchPostsAtom("hello")).not.toBe(searchPostsBefore);
    expect(caseAtom({ targetType: "post", targetId: "post-1" })).not.toBe(caseBefore);
  });

  it("is idempotent — clearing an already-clear store is a no-op", () => {
    const store = freshStore();
    const queryClient = store.get(queryClientAtom);

    expect(() => clearViewerState(queryClient)).not.toThrow();
    expect(() => clearViewerState(queryClient)).not.toThrow();
  });
});
