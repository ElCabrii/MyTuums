import { Link } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toggleFollowAtomFamily } from "@/atoms/follow";
import { viewerIdAtom } from "@/atoms/session";

export function FollowButton({
  userId,
  isFollowing,
  className,
}: {
  userId: string;
  isFollowing: boolean;
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

  if (!viewerId) {
    // Signed out, the server would reject the follow — send people to log in
    // rather than let them click into a 401, matching the like affordance in
    // ./post-card.tsx.
    return (
      <Button
        size="sm"
        nativeButton={false}
        className={className}
        render={<Link to="/login" title="Log in to follow people" className="gap-1.5 rounded-full" />}
      >
        <UserPlus className="h-4 w-4" />
        <span>Follow</span>
      </Button>
    );
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
      aria-label="Unfollow"
      className={`group gap-1.5 rounded-full hover:border-destructive/40 hover:text-destructive ${className ?? ""}`}
    >
      {/* Pure CSS label swap — the button already has a mutation queue, and
          adding hover state to it in React invites the two disagreeing. */}
      <span className="group-hover:hidden">Following</span>
      <span className="hidden group-hover:inline">Unfollow</span>
    </Button>
  ) : (
    <Button
      type="button"
      size="sm"
      onClick={toggleFollow}
      aria-pressed={false}
      aria-label="Follow"
      className={`gap-1.5 rounded-full ${className ?? ""}`}
    >
      <UserPlus className="h-4 w-4" />
      <span>Follow</span>
    </Button>
  );
}
