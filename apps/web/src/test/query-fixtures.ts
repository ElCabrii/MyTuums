import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  AuditLogPage,
  ModerationCaseDetail,
  ModerationQueuePage,
  PostListPage,
  Profile,
  SearchPostsPage,
  SearchUsersPage,
  TeamMember,
  Thread,
  UserListPage,
} from "@/lib/orpc";
import {
  auditLogQueryOptions,
  type CaseRef,
  type FollowDirection,
  moderationCaseQueryOptions,
  moderationQueueQueryOptions,
  postListQueryOptions,
  type PostFeedParams,
  profileQueryOptions,
  searchPostsQueryOptions,
  searchUsersQueryOptions,
  teamQueryOptions,
  teamSearchQueryOptions,
  threadQueryOptions,
  userListQueryOptions,
} from "@/lib/query-definitions";

type CursorPage = { nextCursor: string | null };

function seedPages<TPage extends CursorPage>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  pages: TPage[],
): void {
  queryClient.setQueryData(queryKey, {
    pages,
    pageParams: pages.map((_page, index) =>
      index === 0 ? undefined : (pages[index - 1]?.nextCursor ?? undefined),
    ),
  });
}

function seedInfiniteLoading(queryClient: QueryClient, queryKey: QueryKey): void {
  void queryClient.fetchInfiniteQuery({
    queryKey,
    queryFn: () => new Promise<never>(() => {}),
    initialPageParam:
      // SAFETY: the cursor page param is undefined for the first page; the
      // type parameter comes from the query's input type, not this fixture.
      undefined as string | undefined,
    getNextPageParam: () => undefined,
  });
}

function seedQueryLoading(queryClient: QueryClient, queryKey: QueryKey): void {
  void queryClient.fetchQuery({ queryKey, queryFn: () => new Promise<never>(() => {}) });
}

async function seedQueryError(
  queryClient: QueryClient,
  queryKey: QueryKey,
  error: Error,
): Promise<void> {
  try {
    await queryClient.fetchQuery({ queryKey, queryFn: () => Promise.reject(error) });
  } catch {
    // The cache error state is the fixture this operation produces.
  }
}

async function seedInfiniteError(
  queryClient: QueryClient,
  queryKey: QueryKey,
  message: string,
): Promise<void> {
  try {
    await queryClient.fetchInfiniteQuery({
      queryKey,
      queryFn: () => Promise.reject(new Error(message)),
      initialPageParam:
        // SAFETY: the cursor page param is undefined for the first page; the
        // type parameter comes from the query's input type, not this fixture.
        undefined as string | undefined,
      getNextPageParam: () => undefined,
    });
  } catch {
    // The cache error state is the fixture this operation produces.
  }
}

/**
 * Test-facing interface for server-query state. Callers describe the domain
 * state they need; query keys, pagination metadata, and TanStack cache
 * mechanics stay behind this module.
 */
export function queryFixtures(queryClient: QueryClient) {
  return {
    postList: {
      data(pages: PostListPage[], params: PostFeedParams = { feed: "global" }): void {
        seedPages(queryClient, postListQueryOptions(params).queryKey, pages);
      },
      loading(params: PostFeedParams = { feed: "global" }): void {
        seedInfiniteLoading(queryClient, postListQueryOptions(params).queryKey);
      },
      error(
        message = "Something went wrong",
        params: PostFeedParams = { feed: "global" },
      ): Promise<void> {
        return seedInfiniteError(queryClient, postListQueryOptions(params).queryKey, message);
      },
    },
    profile: {
      data(username: string, profile: Profile): void {
        queryClient.setQueryData(profileQueryOptions(username).queryKey, profile);
      },
      loading(username: string): void {
        seedQueryLoading(queryClient, profileQueryOptions(username).queryKey);
      },
      error(username: string, error: Error): Promise<void> {
        return seedQueryError(queryClient, profileQueryOptions(username).queryKey, error);
      },
    },
    thread: {
      data(postId: string, thread: Thread): void {
        queryClient.setQueryData(threadQueryOptions(postId).queryKey, thread);
      },
      loading(postId: string): void {
        seedQueryLoading(queryClient, threadQueryOptions(postId).queryKey);
      },
      error(postId: string, error: Error): Promise<void> {
        return seedQueryError(queryClient, threadQueryOptions(postId).queryKey, error);
      },
    },
    userList: {
      data(username: string, direction: FollowDirection, pages: UserListPage[]): void {
        seedPages(queryClient, userListQueryOptions(username, direction).queryKey, pages);
      },
      loading(username: string, direction: FollowDirection): void {
        seedInfiniteLoading(queryClient, userListQueryOptions(username, direction).queryKey);
      },
      error(
        username: string,
        direction: FollowDirection,
        message = "Something went wrong",
      ): Promise<void> {
        return seedInfiniteError(
          queryClient,
          userListQueryOptions(username, direction).queryKey,
          message,
        );
      },
    },
    search: {
      users(q: string, pages: SearchUsersPage[]): void {
        seedPages(queryClient, searchUsersQueryOptions(q).queryKey, pages);
      },
      posts(q: string, pages: SearchPostsPage[]): void {
        seedPages(queryClient, searchPostsQueryOptions(q).queryKey, pages);
      },
    },
    moderation: {
      queue(pages: ModerationQueuePage[]): void {
        seedPages(queryClient, moderationQueueQueryOptions().queryKey, pages);
      },
      auditLog(pages: AuditLogPage[]): void {
        seedPages(queryClient, auditLogQueryOptions().queryKey, pages);
      },
      case(target: CaseRef, detail: ModerationCaseDetail): void {
        queryClient.setQueryData(moderationCaseQueryOptions(target).queryKey, detail);
      },
      team(items: TeamMember[]): void {
        queryClient.setQueryData(teamQueryOptions().queryKey, { items });
      },
      teamSearch(q: string, items: TeamMember[]): void {
        queryClient.setQueryData(teamSearchQueryOptions(q).queryKey, { items });
      },
    },
    query: {
      loading(queryKey: QueryKey): void {
        seedQueryLoading(queryClient, queryKey);
      },
      error(queryKey: QueryKey, error: Error): Promise<void> {
        return seedQueryError(queryClient, queryKey, error);
      },
    },
  };
}
