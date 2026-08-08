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
    <div className="border-border bg-card hover:border-primary/30 flex items-center gap-3 rounded-xl border p-4 shadow-sm transition-colors">
      <UserAvatar
        user={user}
        alt={displayName}
        className="bg-background h-11 w-11 shrink-0"
        fallbackClassName="bg-primary text-primary-foreground font-bold text-xs"
      />

      <div className="min-w-0 flex-1">
        {handle ? (
          <Link
            to="/@{$username}"
            params={{ username: handle }}
            className="block min-w-0 hover:underline"
          >
            <span className="text-foreground block truncate text-sm font-bold">{displayName}</span>
            <span className="text-muted-foreground block truncate text-xs">@{handle}</span>
          </Link>
        ) : (
          <span className="text-foreground block truncate text-sm font-bold">{displayName}</span>
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
