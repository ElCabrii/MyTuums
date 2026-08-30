import type { ReactNode } from "react";
import { useAtomValue } from "jotai";
import { MessageSquare } from "lucide-react";
import { PostCard } from "@/components/post-card";
import { PaginatedState } from "@/components/paginated-state";
import type { postFeedAtom } from "@/atoms/post-feed";
import { m } from "@/paraglide/messages.js";

/**
 * A paginated post feed with loading, retryable-error, empty and "Load more"
 * states. The query lives in the `feedAtom` prop — scope and author are
 * atom-family parameters, so this component never knows what it is showing.
 * The four-state skeleton itself is shared (`./paginated-state.tsx`); this
 * component owns the feed's texts and row renderer.
 */
export function PostFeed({
  feedAtom,
  emptyMessage,
  emptyAction,
  showParentContext = false,
}: {
  /** The feed atom to read — parameterisation (scope, author) lives entirely in atom-land; see `atoms/post-feed.ts`. */
  feedAtom: ReturnType<typeof postFeedAtom>;
  emptyMessage: string;
  /** Rendered under `emptyMessage` — e.g. a "find people to follow" CTA. */
  emptyAction?: ReactNode;
  /** Render the immediate-parent preview used by profile activity cards. */
  showParentContext?: boolean;
}) {
  const feed = useAtomValue(feedAtom);
  const posts = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PaginatedState
      query={feed}
      errorMessage={m.feed_load_error()}
      emptyIcon={MessageSquare}
      emptyMessage={emptyMessage}
      isEmpty={posts.length === 0}
      emptyAction={emptyAction}
      listClassName="space-y-4"
    >
      {posts.map((post) => (
        // The same post can be two legitimate timeline events — authored at
        // its own timestamp and reposted later. Key by event identity, not the
        // original post id, so React never reuses one card for the other.
        <PostCard
          key={`${post.id}:${post.repostedBy?.id ?? "post"}:${post.repostedBy?.repostedAt.toISOString() ?? ""}`}
          post={post}
          showParentContext={showParentContext}
        />
      ))}
    </PaginatedState>
  );
}
