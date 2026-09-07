import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc, orpc, type PostListPage } from "@/lib/orpc";

const fakeClient = {
  user: {
    byUsername: vi.fn(),
    followers: vi.fn(),
    following: vi.fn(),
    followRequest: {
      list: vi.fn(),
      cancel: vi.fn(),
      accept: vi.fn(),
      reject: vi.fn(),
    },
  },
  notification: { list: vi.fn(), unreadCount: vi.fn() },
  search: { users: vi.fn() },
  post: { list: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

import { cancelFollowRequestAtom } from "@/atoms/follow-requests";
import { makePostListPage, makeRanking, makeRankSuggestion } from "@/test/factories";

/**
 * Withdrawing an outgoing request flips the suggestion row back to Follow in
 * place (issue #328 meets #305): patched, never refetched, so the pinned
 * Discover snapshot — and its post order — never moves for a request that
 * was never a feed membership.
 */
describe("cancelFollowRequestAtom", () => {
  it("clears the requested flag on the suggestion row without invalidating the ranked feed", async () => {
    const store = createStore();
    const queryClient = new QueryClient();
    store.set(queryClientAtom, queryClient);
    const rankedKey = orpc.post.list.key({ input: { limit: 20, feed: "discover", ranked: true } });
    queryClient.setQueryData<InfiniteData<PostListPage>>(rankedKey, {
      pages: [
        makePostListPage({
          ranking: makeRanking({
            suggestions: [
              makeRankSuggestion({
                id: "target-1",
                username: "target",
                viewerIsFollowing: false,
                hasRequested: true,
              }),
            ],
          }),
        }),
      ],
      pageParams: [undefined],
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    fakeClient.user.followRequest.cancel.mockResolvedValue({ targetId: "target-1" });

    const unsub = store.sub(cancelFollowRequestAtom, () => {});
    store.get(cancelFollowRequestAtom).mutate({ targetId: "target-1" });

    await vi.waitFor(() => {
      const suggestions =
        queryClient.getQueryData<InfiniteData<PostListPage>>(rankedKey)?.pages[0]?.ranking
          ?.suggestions ?? [];
      expect(suggestions.find((i) => i.id === "target-1")?.hasRequested).toBe(false);
    });
    expect(
      queryClient
        .getQueryData<InfiniteData<PostListPage>>(rankedKey)
        ?.pages[0]?.ranking?.suggestions.find((i) => i.id === "target-1")?.viewerIsFollowing,
    ).toBe(false);
    // The ranked feed itself is never invalidated for a withdrawn request —
    // neither its exact entry nor the shared post.list prefix.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: rankedKey });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: orpc.post.list.key() });

    unsub();
  });
});
