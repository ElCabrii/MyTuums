import {
  FOLLOW_PAGE_SIZE,
  MODERATION_PAGE_SIZE,
  POST_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
} from "@my-tuums/api/constants";
import type { FeedScope } from "@/lib/feed-scope";
import { orpc, retryUnlessClientError } from "@/lib/orpc";

interface PostListInput {
  limit: number;
  authorId?: string;
  parentId?: string;
  includeReplies?: boolean;
  feed?: FeedScope;
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

export type CaseRef = { targetType: "post" | "user"; targetId: string };

export type FollowDirection = "followers" | "following";

export type PostFeedParams = {
  /** Omit for the global timeline; set to scope the feed to one author. */
  authorId?: string;
  /** "following" requires a signed-in viewer; the server rejects it otherwise. */
  feed: FeedScope;
  /** Set to list one post's direct replies — the thread page's reply list. */
  parentId?: string;
  /** Replies are excluded unless this is set; a profile feed opts in. */
  includeReplies?: boolean;
};

/** Authoritative query definitions shared by production atoms and test fixtures. */
export function postListQueryOptions({
  authorId,
  feed: scope,
  parentId,
  includeReplies,
}: PostFeedParams) {
  return orpc.post.list.infiniteOptions({
    input: (cursor: string | undefined) => {
      const input: PostListInput = { limit: POST_PAGE_SIZE };
      if (authorId) input.authorId = authorId;
      if (parentId) input.parentId = parentId;
      if (includeReplies) input.includeReplies = true;
      if (scope === "following") input.feed = scope;
      if (cursor) input.cursor = cursor;
      return input;
    },
    initialPageParam:
      // SAFETY: the first page has no cursor; the page-param type flows from the input getter.
      undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function profileQueryOptions(username: string) {
  return {
    ...orpc.user.byUsername.queryOptions({ input: { username } }),
    retry: retryUnlessClientError,
  };
}

export function threadQueryOptions(postId: string) {
  return {
    ...orpc.post.thread.queryOptions({ input: { postId } }),
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
