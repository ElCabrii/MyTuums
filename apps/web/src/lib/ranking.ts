import { ORPCError } from "@orpc/client";
import { RANK_SNAPSHOT_INVALID_MESSAGE } from "@my-tuums/api/constants";
import type { PostListPage } from "@/lib/orpc";

/**
 * The ranked-feed metadata `post.list` carries on every branch (issue #305).
 * Derived from the procedure's own page type — the single source of truth —
 * so the web tracks the contract without restating it.
 */
export type RankingMetadata = NonNullable<PostListPage["ranking"]>;
export type RankingSuggestion = RankingMetadata["suggestions"][number];

/**
 * The ranking block of one `post.list` page, when the server filled it.
 * Chronological branches carry `ranking: null`; ranked branches carry the
 * snapshot block.
 */
export function getPageRanking(page: PostListPage): RankingMetadata | undefined {
  return page.ranking ?? undefined;
}

/** The ranking block of a loaded feed — the first page that carries one. */
export function getFeedRanking(pages: PostListPage[] | undefined): RankingMetadata | undefined {
  if (!pages) return undefined;
  for (const page of pages) {
    const ranking = getPageRanking(page);
    if (ranking) return ranking;
  }
  return undefined;
}

/** Invalid snapshot resumes need Refresh, not a retry with the same snapshot. */
export function isSnapshotExpiredError(error: Error | null): boolean {
  return (
    error instanceof ORPCError &&
    error.code === "BAD_REQUEST" &&
    error.message === RANK_SNAPSHOT_INVALID_MESSAGE
  );
}
