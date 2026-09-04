import {
  FOLLOW_PAGE_SIZE,
  GAMES_PAGE_SIZE,
  MODERATION_PAGE_SIZE,
  NOTIFICATION_PAGE_SIZE,
  POST_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
} from "@my-tuums/api/constants";
import type { FeedScope } from "@/lib/feed-scope";
import { orpc, retryUnlessClientError } from "@/lib/orpc";

interface PostListInput {
  limit: number;
  authorId?: string;
  parentId?: string;
  continuationRootId?: string;
  includeReplies?: boolean;
  includeReposts?: boolean;
  kind?: "posts" | "replies" | "all";
  feed?: FeedScope | "bookmarks";
  cursor?: string;
}
interface PagedSearchInput {
  q: string;
  limit: number;
  cursor?: string;
}
interface PagedUserListInput {
  username: string;
  limit: number;
  cursor?: string;
}
interface PagedModerationInput {
  limit: number;
  cursor?: string;
}
interface PagedNotificationInput {
  limit: number;
  cursor?: string;
}

export type CaseRef = { targetType: "post" | "user"; targetId: string };

export type FollowDirection = "followers" | "following";

/** The profile activity views; `both` preserves the legacy includeReplies input. */
export type PostFeedKind = "posts" | "replies" | "both";

/**
 * Which `post.list` scope a feed atom reads. The two home scopes are the
 * persisted `FeedScope`; `bookmarks` is the caller's private saved page and is
 * never a home-feed choice — it deliberately stays out of `feedScopeAtom`'s
 * enum so a hand-edited `localStorage` value can never select it.
 */
export type PostListScope = FeedScope | "bookmarks";

export type PostFeedParams = {
  /** Omit for the global timeline; set to scope the feed to one author. */
  authorId?: string;
  /** "following" requires a signed-in viewer; the server rejects it otherwise. */
  feed: PostListScope;
  /** Set to list one post's direct replies — the thread page's reply list. */
  parentId?: string;
  /** Replies are excluded unless this is set; a profile feed opts in. */
  includeReplies?: boolean;
  /** The author's own repost events join the profile feed when this is set. */
  includeReposts?: boolean;
  /** Profile-only three-way filter; `both` is encoded as legacy includeReplies. */
  kind?: PostFeedKind;
};

/** Authoritative query definitions shared by production atoms and test fixtures. */
export function postListQueryOptions({
  authorId,
  feed: scope,
  parentId,
  includeReplies,
  includeReposts,
  kind,
}: PostFeedParams) {
  return orpc.post.list.infiniteOptions({
    input: (cursor: string | undefined) => {
      const input: PostListInput = { limit: POST_PAGE_SIZE };
      if (authorId) input.authorId = authorId;
      if (parentId) input.parentId = parentId;
      if (kind === "replies") input.kind = "replies";
      else if (kind === "both" || includeReplies) input.includeReplies = true;
      // Same conditional-spread rule as the fields above: only a profile
      // feed sets this, so every other feed's key stays exactly as it was.
      if (includeReposts) input.includeReposts = true;
      // The global feed keeps a bare key (see the note on the conditional
      // spreads above); the two scoped feeds carry their discriminator.
      if (scope === "following" || scope === "bookmarks") input.feed = scope;
      if (cursor) input.cursor = cursor;
      return input;
    },
    initialPageParam:
      // SAFETY: the first page has no cursor; the page-param type flows from the input getter.
      undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/** Loads continuation pages after the branch slice embedded in a direct-reply page. */
export function replyContinuationQueryOptions(rootPostId: string, initialCursor: string) {
  return orpc.post.list.infiniteOptions({
    input: (cursor: string | undefined) => {
      const input: PostListInput = {
        limit: POST_PAGE_SIZE,
        continuationRootId: rootPostId,
      };
      if (cursor) input.cursor = cursor;
      return input;
    },
    initialPageParam: initialCursor,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function profileQueryOptions(username: string) {
  return {
    ...orpc.user.byUsername.queryOptions({ input: { username } }),
    retry: retryUnlessClientError,
    // Hover cards unmount when they close. Keep recently viewed profiles fresh
    // long enough that moving between links does not refetch the same person.
    staleTime: 60_000,
  };
}

/** The `/games` index's list parameters — `q` is the page's filter bar. */
export interface GameListParams {
  sort: "popularity" | "name" | "year";
  q?: string;
}

interface PagedGameListInput {
  sort: "popularity" | "name" | "year";
  limit: number;
  q?: string;
  cursor?: string;
}

/**
 * One game's public page. `retryUnlessClientError` because a NOT_FOUND slug
 * is a client error — retrying it would just ask again for a game that is
 * not there.
 */
export function gameQueryOptions(slug: string) {
  return {
    ...orpc.game.bySlug.queryOptions({ input: { slug } }),
    retry: retryUnlessClientError,
  };
}

/**
 * The game directory's list, keyset-paginated per sort. The conditional `q`
 * spread follows the same rule as `postListQueryOptions`' fields: a bare
 * key for the unfiltered listing, a discriminated one the moment a filter
 * exists, so the two never share a cache entry.
 */
export function gameListQueryOptions({ sort, q }: GameListParams) {
  const normalized = q?.trim();
  return orpc.game.list.infiniteOptions({
    input: (cursor: string | undefined) => {
      const input: PagedGameListInput = { sort, limit: GAMES_PAGE_SIZE };
      if (normalized) input.q = normalized;
      if (cursor) input.cursor = cursor;
      return input;
    },
    initialPageParam:
      // SAFETY: the first page has no cursor; the page-param type flows from the input getter.
      undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function threadQueryOptions(postId: string) {
  return {
    ...orpc.post.thread.queryOptions({ input: { postId } }),
    retry: retryUnlessClientError,
  };
}

/**
 * The link preview card for one URL — the first URL of a post, as picked by
 * the linkifier (`firstLinkUrl`), never a URL the renderer would not link.
 *
 * The server caches the fetch per URL with its own revalidation window; this
 * staleTime only keeps remounts (a feed scrolling the same card back into
 * view) from re-asking. A `{ card: null }` answer is cached the same way —
 * "no card" is a stable property of the URL within the window, and refetching
 * it per view is exactly what the procedure's rate tier exists to stop.
 */
export function linkCardQueryOptions(url: string) {
  return {
    ...orpc.post.linkCard.queryOptions({ input: { url } }),
    staleTime: 5 * 60_000,
    retry: retryUnlessClientError,
  };
}

export function userListQueryOptions(username: string, direction: FollowDirection) {
  const procedure = direction === "followers" ? orpc.user.followers : orpc.user.following;
  return procedure.infiniteOptions({
    input: (cursor: string | undefined) => {
      const input: PagedUserListInput = { username, limit: FOLLOW_PAGE_SIZE };
      if (cursor) input.cursor = cursor;
      return input;
    },
    initialPageParam:
      // SAFETY: the first page has no cursor; the page-param type flows from the input getter.
      undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function searchUsersQueryOptions(q: string) {
  const normalized = q.trim();
  return {
    ...orpc.search.users.infiniteOptions({
      input: (cursor: string | undefined) => {
        const input: PagedSearchInput = {
          q: normalized,
          limit: SEARCH_PAGE_SIZE,
        };
        if (cursor) input.cursor = cursor;
        return input;
      },
      initialPageParam:
        // SAFETY: the first page has no cursor; the page-param type flows from the input getter.
        undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
    enabled: normalized.length > 0,
  };
}

export function searchPostsQueryOptions(q: string) {
  const normalized = q.trim();
  return {
    ...orpc.search.posts.infiniteOptions({
      input: (cursor: string | undefined) => {
        const input: PagedSearchInput = {
          q: normalized,
          limit: SEARCH_PAGE_SIZE,
        };
        if (cursor) input.cursor = cursor;
        return input;
      },
      initialPageParam:
        // SAFETY: the first page has no cursor; the page-param type flows from the input getter.
        undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
    enabled: normalized.length > 0,
  };
}

export function moderationQueueQueryOptions() {
  return orpc.moderation.queue.infiniteOptions({
    input: (cursor: string | undefined) => {
      const input: PagedModerationInput = { limit: MODERATION_PAGE_SIZE };
      if (cursor) input.cursor = cursor;
      return input;
    },
    initialPageParam:
      // SAFETY: the first page has no cursor; the page-param type flows from the input getter.
      undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function auditLogQueryOptions() {
  return orpc.moderation.auditLog.infiniteOptions({
    input: (cursor: string | undefined) => {
      const input: PagedModerationInput = { limit: MODERATION_PAGE_SIZE };
      if (cursor) input.cursor = cursor;
      return input;
    },
    initialPageParam:
      // SAFETY: the first page has no cursor; the page-param type flows from the input getter.
      undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function moderationCaseQueryOptions(ref: CaseRef) {
  const input: { targetType: "post"; targetId: string } | { targetType: "user"; targetId: string } =
    ref.targetType === "post"
      ? { targetType: "post", targetId: ref.targetId }
      : { targetType: "user", targetId: ref.targetId };
  return orpc.moderation.case.queryOptions({ input });
}

export function teamQueryOptions() {
  return orpc.moderation.team.queryOptions();
}

/** The viewer's notifications, newest first — one feed, no scope parameters. */
export function notificationsQueryOptions() {
  return orpc.notification.list.infiniteOptions({
    input: (cursor: string | undefined) => {
      const input: PagedNotificationInput = { limit: NOTIFICATION_PAGE_SIZE };
      if (cursor) input.cursor = cursor;
      return input;
    },
    initialPageParam:
      // SAFETY: the first page has no cursor; the page-param type flows from the input getter.
      undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/**
 * The unread badge count. No polling and no custom staleness: the app's
 * QueryClient defaults refetch on mount and on window focus, which is the
 * same freshness contract every other surface lives by — the badge moves
 * when the reader next looks at the app, not on a timer.
 */
export function unreadCountQueryOptions() {
  return orpc.notification.unreadCount.queryOptions({ input: {} });
}

/**
 * The removed post an appeal is about — what the appeal page shows above its
 * form so nobody has to argue about a post they cannot see.
 *
 * `enabled` gates two things at once. There may be no identifier at all (the
 * page's "nothing to appeal" state), and the procedure is session-gated while
 * the page itself is not: a signed-out visitor holding a suspension or ban
 * link would only ever get UNAUTHORIZED, so the query is never sent rather
 * than fired to fail. The form does not depend on any of this.
 */
export function appealPreviewQueryOptions(
  identifier: { token?: string; postId?: string },
  isSignedIn: boolean,
) {
  const input: { token?: string; postId?: string } = identifier.token
    ? { token: identifier.token }
    : identifier.postId
      ? { postId: identifier.postId }
      : {};
  return {
    ...orpc.moderation.appealPreview.queryOptions({ input }),
    enabled: isSignedIn && (Boolean(identifier.token) || Boolean(identifier.postId)),
    retry: retryUnlessClientError,
  };
}

/**
 * The Team tab's account lookup — how staff reach someone the roster does not
 * list, so they can be granted a role.
 *
 * `enabled` gates the empty query the same way `searchUsersQueryOptions` does:
 * the field starts empty and the procedure rejects an empty `q`.
 */
export function teamSearchQueryOptions(q: string) {
  const normalized = q.trim();
  return {
    ...orpc.moderation.searchUsers.queryOptions({ input: { q: normalized } }),
    enabled: normalized.length > 0,
    retry: retryUnlessClientError,
  };
}
