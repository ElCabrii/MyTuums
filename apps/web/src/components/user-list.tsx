import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Users } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import { FollowButton } from "@/components/follow-button";
import { PaginatedState } from "@/components/paginated-state";
import { userListAtom, type FollowDirection } from "@/atoms/user-list";
import type { SearchUser, UserSummary } from "@/lib/orpc";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

/**
 * One row in a people list — avatar, profile link and follow button. Shared
 * by the follower/following dialogs and the search results page; `SearchUser`
 * and `UserSummary` differ only in fields the row never touches.
 */
export function UserRow({ user }: { user: UserSummary | SearchUser }) {
  const handle = handleOf(user);
  const displayName = user.name || handle || m.user_unknown();

  return (
    <div className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card shadow-sm hover:border-primary/30 transition-colors">
      <UserAvatar
        user={user}
        alt={displayName}
        className="h-11 w-11 bg-background shrink-0"
        fallbackClassName="bg-primary text-primary-foreground font-bold text-xs"
      />

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
 * same spinner / dashed empty state / role="alert" retry treatment — shared
 * through `./paginated-state.tsx` — so the two lists behave identically.
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
  const list = useAtomValue(userListAtom(username, direction));
  const people = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PaginatedState
      query={list}
      errorMessage={m.follow_list_load_error()}
      emptyIcon={Users}
      emptyMessage={emptyMessage}
      isEmpty={people.length === 0}
      listClassName="space-y-3"
    >
      {people.map((person) => (
        <UserRow key={person.id} user={person} />
      ))}
    </PaginatedState>
  );
}
