import { atomWithInfiniteQuery, atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import type { QueryClient } from "@tanstack/react-query";
import { followRequestListQueryOptions } from "@/lib/query-definitions";
import { orpc } from "@/lib/orpc";

/**
 * Inbound follow requests against the viewer's private account (issue #328),
 * newest first. One feed, no parameters — the viewer is the inbox.
 */
export const followRequestListAtom = atomWithInfiniteQuery(() => followRequestListQueryOptions());

function invalidateRequestCaches(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: orpc.user.followRequest.list.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.notification.list.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.notification.unreadCount.key() });
  // Accepting grows the viewer's followerCount; rejecting/cancelling moves
  // `hasRequested` on the other party's cached rows. Both are profile-shaped,
  // so refetch profiles rather than patching them — requests are rare.
  void queryClient.invalidateQueries({ queryKey: orpc.user.byUsername.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.user.followers.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.user.following.key() });
}

/** Accepts a pending request — the requester becomes a follower. */
export const acceptFollowRequestAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.user.followRequest.accept.mutationOptions({
    onSuccess: () => invalidateRequestCaches(queryClient),
  });
});

/** Rejects a pending request — the row goes away, no edge. */
export const rejectFollowRequestAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.user.followRequest.reject.mutationOptions({
    onSuccess: () => invalidateRequestCaches(queryClient),
  });
});

/** Withdraws the viewer's own outgoing request. */
export const cancelFollowRequestAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.user.followRequest.cancel.mutationOptions({
    onSuccess: () => {
      invalidateRequestCaches(queryClient);
      // The cancelled row was outgoing — the target's profile button flips
      // back to Follow, which lives under the same profile/list keys above.
      // The requester's own Following feed is unaffected (a request was never
      // a membership), so no feed invalidation is needed.
      void queryClient.invalidateQueries({ queryKey: orpc.search.users.key() });
    },
  });
});
