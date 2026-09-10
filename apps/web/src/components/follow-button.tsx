import { useAtomValue, useSetAtom } from "jotai";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toggleFollowAtomFamily } from "@/atoms/follow";
import { cancelFollowRequestAtom } from "@/atoms/follow-requests";
import { viewerIdAtom } from "@/atoms/session";
import { m } from "@/paraglide/messages.js";

/**
 * The withdraw control for a pending request — split from `FollowButton`
 * below so the Follow/Following states never subscribe to the request
 * mutation. Existing tests mount those states without a `followRequest`
 * mock; only this branch needs one.
 */
function RequestedButton({ userId, className }: { userId: string; className?: string }) {
  // A mutation atom, not a write-only action — `useAtomValue` yields
  // `{ mutate }`, where `useSetAtom` would give the setter type error.
  const cancelRequest = useAtomValue(cancelFollowRequestAtom);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => cancelRequest.mutate({ targetId: userId })}
      aria-pressed={false}
      aria-label={m.follow_cancel_request()}
      className={`gap-1.5 rounded-full ${className ?? ""}`}
    >
      <span>{m.follow_requested()}</span>
    </Button>
  );
}

/**
 * The Follow/Requested/Unfollow control for a user row (issue #328 adds the
 * middle state) — write-only and optimistic for the edge, invalidation for
 * the request withdraw, and nothing on the viewer's own row. Signed-out
 * visitors never render this (every route it appears on is gated), so the
 * old login-link branch is gone.
 */
export function FollowButton({
  userId,
  isFollowing,
  hasRequested,
  className,
}: {
  userId: string;
  isFollowing: boolean;
  /** Pending outbound request (issue #328). Omitted reads as none. */
  hasRequested?: boolean;
  className?: string;
}) {
  const viewerId = useAtomValue(viewerIdAtom);
  // Write-only: this button renders no pending or disabled state, so it has no
  // reason to subscribe to mutation status. The optimistic flip is the
  // feedback, and disabling for the round trip would block a fast undo.
  const toggleFollow = useSetAtom(toggleFollowAtomFamily(userId));

  // Following yourself is a BAD_REQUEST server-side and forbidden by a CHECK
  // constraint, so there is no state in which this button is meaningful on
  // your own row. Callers guard too; this is the backstop.
  if (viewerId === userId) return null;

  // A pending request withdraws rather than unfollows — the edge never
  // existed, so `toggleFollow` (which would delete a non-row) is the wrong
  // call. Invalidation flips the button back to Follow once the delete lands;
  // the request is rare enough that no optimistic patch is worth the
  // rollback surface.
  if (!isFollowing && hasRequested) {
    return <RequestedButton userId={userId} className={className} />;
  }

  // Deliberately no pending/disabled state: the optimistic flip *is* the
  // feedback and it lands on click, while disabling for the round trip would
  // block a fast undo — exactly the interaction the mutation scope above
  // exists to make safe.
  return isFollowing ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={toggleFollow}
      aria-pressed
      aria-label={m.follow_unfollow()}
      className={`group hover:border-destructive/40 hover:text-destructive gap-1.5 rounded-full ${className ?? ""}`}
    >
      {/* Pure CSS label swap — the button already has a mutation queue, and
          adding hover state to it in React invites the two disagreeing. */}
      <span className="group-hover:hidden">{m.follow_following()}</span>
      <span className="hidden group-hover:inline">{m.follow_unfollow()}</span>
    </Button>
  ) : (
    <Button
      type="button"
      size="sm"
      onClick={toggleFollow}
      aria-pressed={false}
      aria-label={m.follow_action()}
      className={`gap-1.5 rounded-full ${className ?? ""}`}
    >
      <UserPlus className="h-4 w-4" />
      <span>{m.follow_action()}</span>
    </Button>
  );
}
