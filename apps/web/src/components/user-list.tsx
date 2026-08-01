import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { AlertCircle, Loader2, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FollowButton } from "@/components/follow-button";
import { isSignedInAtom } from "@/atoms/session";
import { userListAtom, type FollowDirection } from "@/atoms/user-list";
import { type UserSummary } from "@/lib/orpc";
import { handleOf, initialsOf } from "@/lib/user";

function UserRow({ user }: { user: UserSummary }) {
  const handle = handleOf(user);
  const displayName = user.name || handle || "Unknown";

  return (
    <div className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card shadow-sm hover:border-primary/30 transition-colors">
      <Avatar className="h-11 w-11 bg-background shrink-0">
        <AvatarImage src={user.image || undefined} alt={displayName} />
        <AvatarFallback className="bg-primary text-primary-foreground font-bold text-xs">
          {initialsOf(displayName)}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        {handle ? (
          <Link
            to="/@{$username}"
            params={{ username: handle }}
            className="block min-w-0 hover:underline"
          >
            <span className="block font-bold text-sm text-foreground truncate">
              {displayName}
            </span>
            <span className="block text-xs text-muted-foreground truncate">@{handle}</span>
          </Link>
        ) : (
          <span className="block font-bold text-sm text-foreground truncate">{displayName}</span>
        )}
      </div>

      <FollowButton userId={user.id} isFollowing={user.viewerIsFollowing} />
    </div>
  );
}

/**
 * A paginated list of people — the body of the follower and following dialogs
 * opened from a profile's counts (./follow-list-dialog.tsx).
 *
 * Structurally a mirror of ./post-feed.tsx: the same conditional-spread input,
 * the same "Load more" button rather than an intersection observer, and the
 * same spinner / dashed empty state / role="alert" retry treatment, so the two
 * lists behave identically.
 */
export function UserList({
  username,
  direction,
  emptyMessage,
}: {
  username: string;
  /** "followers" = people following them; "following" = people they follow. */
  direction: FollowDirection;
  emptyMessage: string;
}) {
  const isSignedIn = useAtomValue(isSignedInAtom);
  const list = useAtomValue(userListAtom(username, direction));

  if (list.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (list.isError) {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="space-y-2">
          <p>{list.error.message || "Could not load this list."}</p>
          <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const people = list.data.pages.flatMap((page) => page.items);

  if (people.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
        <Users className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {people.map((person) => (
        <UserRow key={person.id} user={person} />
      ))}

      {list.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            className="gap-2 rounded-full"
          >
            {list.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>Load more</span>
          </Button>
        </div>
      )}

      {/* Referenced so the signed-out case is obvious to a reader: the rows
          render a login link rather than a live follow toggle. */}
      {!isSignedIn && (
        <p className="pt-1 text-center text-xs text-muted-foreground">
          <Link to="/login" className="hover:underline">
            Log in
          </Link>{" "}
          to follow people from here.
        </p>
      )}
    </div>
  );
}
