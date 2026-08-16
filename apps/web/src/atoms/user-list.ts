import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithInfiniteQuery } from "jotai-tanstack-query";
import { type FollowDirection, userListQueryOptions } from "@/lib/query-definitions";

export type { FollowDirection } from "@/lib/query-definitions";

/**
 * The family key. Direction goes FIRST deliberately: it is a two-value union,
 * so it is always the prefix and `decode` can split on the first ":" and stay
 * total no matter what a handle contains. Handles are `[a-zA-Z0-9_-]` today
 * (the BetterAuth username plugin enforces it), but the key shouldn't silently
 * depend on a rule enforced three packages away.
 *
 * A primitive string rather than a `{ username, direction }` object, for the
 * same reason as `profileAtomFamily` and `postFeedFamily`: an object param
 * forces an `areEqual` comparator, and passing one switches `atomFamily` from
 * a `Map` lookup to a linear scan over every param it has ever created, on
 * every read.
 */
/** Encodes (direction, username) into the family key — why direction is first is explained above. */
export const encode = (username: string, direction: FollowDirection): string =>
  `${direction}:${username}`;

/** Decodes a family key back into (direction, username) — the inverse of {@link encode}. */
export const decode = (key: string): DecodedUserListKey => {
  const separator = key.indexOf(":");
  return {
    // SAFETY: encode only ever writes one of the two literal directions.
    direction: key.slice(0, separator) as FollowDirection,
    username: key.slice(separator + 1),
  };
};

interface DecodedUserListKey {
  username: string;
  direction: FollowDirection;
}

/**
 * One infinite-query atom per (direction, handle) pair.
 *
 * Deliberately no `setShouldRemove`, matching `profileAtomFamily` and
 * `postFeedFamily`: it is evaluated lazily at read time and cannot know
 * whether an atom is currently mounted, so it can hand two reads of identical
 * params two different atoms and discard an in-progress "Load more"
 * scroll-through. Cleanup happens at sign-out instead, where nothing is
 * mounted to split.
 */
const userListFamily = atomFamily((key: string) =>
  atomWithInfiniteQuery(() => {
    const { username, direction } = decode(key);
    return userListQueryOptions(username, direction);
  }),
);

/** The infinite-query atom for one (direction, handle) list — components read this, not the family. */
export const userListAtom = (username: string, direction: FollowDirection) =>
  userListFamily(encode(username, direction));

/**
 * Removes every entry `userListFamily` has ever created. Exported as a
 * function rather than exporting the family itself, so the family's
 * `remove`/`getParams` stay behind this one narrow, all-or-nothing entry
 * point instead of being handed to callers wholesale — the same reasoning as
 * `clearPostFeedFamily` in `atoms/post-feed.ts`. `clearViewerState`
 * (`atoms/session-teardown.ts`) is the only caller, and sign-out is the one
 * moment nothing here is mounted, so a full sweep can't split an open
 * dialog's in-progress pagination.
 */
export function clearUserListFamily(): void {
  for (const key of userListFamily.getParams()) userListFamily.remove(key);
}

/**
 * Which follower/following dialog is open, app-wide — at most one.
 *
 * This replaces a `useState(false)` per dialog plus a `useEffect` that
 * force-closed it whenever the `username` prop changed. That effect existed
 * because rows inside the list link to other profiles, and that navigation
 * happens *underneath* the open dialog: without it, the dialog stayed up and
 * quietly reloaded with the new person's list.
 *
 * Holding the identity of the open dialog rather than a per-instance boolean
 * removes the need to reconcile at all. Each `FollowListDialog` derives its
 * own `open` by comparing this value against its own props, so navigating to
 * another handle makes that comparison false on its own — there is no state
 * to correct after the fact, and therefore no effect.
 *
 * `direction` is part of the identity because a profile renders two of these
 * side by side; keying on `username` alone would open both at once.
 */
export const followListDialogAtom = atom<{
  username: string;
  direction: FollowDirection;
} | null>(null);
