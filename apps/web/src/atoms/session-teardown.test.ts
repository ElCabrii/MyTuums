import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { clearViewerState } from "@/atoms/session-teardown";
import { profileAtomFamily } from "@/atoms/profile";
import { postFeedAtom } from "@/atoms/post-feed";
import { threadAtomFamily } from "@/atoms/thread";
import { userListAtom } from "@/atoms/user-list";
import { searchPostsAtom, searchUsersAtom } from "@/atoms/search";
import { toggleLikeAtomFamily } from "@/atoms/like";
import { toggleFollowAtomFamily } from "@/atoms/follow";
import { createReplyAtomFamily, replyDraftAtomFamily } from "@/atoms/reply-composer";
import { caseAtom } from "@/atoms/moderation";
import {
  createTestQueryClient,
  makeModerationCaseDetail,
  makePost,
  makeProfile,
  makeThread,
  makeUserSummary,
  queryFixtures,
} from "@/test/render";

/**
 * Everything here goes through `clearViewerState` and the *public* readers of
 * the families it sweeps — `postFeedAtom(params)`, `caseAtom(ref)`, and so on.
 * Nothing reaches for a family's `remove`/`getParams`, and nothing asserts on
 * which `clear*` helpers ran, so the inventory inside the module stays free to
 * change shape as long as the state actually goes.
 */

describe("clearViewerState", () => {
  it("empties the query cache before loading the family modules", async () => {
    const queryClient = createTestQueryClient();
    const fixtures = queryFixtures(queryClient);
    const profileBefore = profileAtomFamily("cache-clear-marker");

    // Viewer-relative rows behind viewer-less query keys: the exact reason the
    // cache is cleared wholesale rather than invalidated.
    fixtures.profile.data("alexmercer", makeProfile({ viewerIsFollowing: true }));
    fixtures.postList.data([{ items: [makePost({ viewerHasLiked: true })], nextCursor: null }]);
    fixtures.thread.data("post-1", makeThread());
    fixtures.userList.data("alexmercer", "followers", [
      { items: [makeUserSummary({ viewerIsFollowing: true })], nextCursor: null },
    ]);
    fixtures.moderation.case(
      { targetType: "post", targetId: "post-1" },
      makeModerationCaseDetail(),
    );
    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);

    const result = clearViewerState(queryClient);

    expect(result).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    await vi.waitFor(() => {
      expect(profileAtomFamily("cache-clear-marker")).not.toBe(profileBefore);
    });
  });

  /**
   * One entry per family the teardown covers, read through the accessor the
   * app itself uses. A family that survived teardown would hand back the same
   * atom object — and with it the previous viewer's observer, mutation result
   * or intent — so identity is the assertion.
   */
  const familyReaders = [
    { family: "profile", read: (): object => profileAtomFamily("alexmercer") },
    { family: "post feed", read: (): object => postFeedAtom({ feed: "global" }) },
    { family: "thread", read: (): object => threadAtomFamily("post-1") },
    { family: "user list", read: (): object => userListAtom("alexmercer", "followers") },
    { family: "search users", read: (): object => searchUsersAtom("alex") },
    { family: "search posts", read: (): object => searchPostsAtom("alex") },
    { family: "like toggle", read: (): object => toggleLikeAtomFamily("post-1") },
    { family: "follow toggle", read: (): object => toggleFollowAtomFamily("user-1") },
    { family: "reply mutation", read: (): object => createReplyAtomFamily("post-1") },
    {
      family: "moderation case",
      read: (): object => caseAtom({ targetType: "post", targetId: "post-1" }),
    },
  ];

  it.each(familyReaders)("hands the $family family a fresh atom afterwards", async ({ read }) => {
    const before = read();

    clearViewerState(createTestQueryClient());

    await vi.waitFor(() => {
      expect(read()).not.toBe(before);
    });
  });

  it("resets per-entry state, not just atom identity — a half-typed reply is gone", async () => {
    const store = createStore();
    store.set(replyDraftAtomFamily("post-1"), "a half-typed reply");

    clearViewerState(createTestQueryClient());

    await vi.waitFor(() => {
      expect(store.get(replyDraftAtomFamily("post-1"))).toBe("");
    });
  });
});
