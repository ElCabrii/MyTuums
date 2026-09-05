import type { ReactNode } from "react";
import { useAtomValue } from "jotai";
import { MessageSquare } from "lucide-react";
import { PostCard } from "@/components/post-card";
import { PaginatedState } from "@/components/paginated-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { postFeedAtom } from "@/atoms/post-feed";
import { mergedGameMentions } from "@/lib/game-mentions";
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
  emptyIcon = MessageSquare,
  showParentContext = false,
}: {
  /** The feed atom to read — parameterisation (scope, author) lives entirely in atom-land; see `atoms/post-feed.ts`. */
  feedAtom: ReturnType<typeof postFeedAtom>;
  emptyMessage: string;
  /** Rendered under `emptyMessage` — e.g. a "find people to follow" CTA. */
  emptyAction?: ReactNode;
  /** The empty state's icon; a bookmark for the saved list, a message square elsewhere. */
  emptyIcon?: typeof MessageSquare;
  /** Render the immediate-parent preview used by profile activity cards. */
  showParentContext?: boolean;
}) {
  const feed = useAtomValue(feedAtom);
  const posts = feed.data?.pages.flatMap((page) => page.items) ?? [];
  const gameMentions = mergedGameMentions(feed.data?.pages ?? []);

  return (
    <PaginatedState
      query={feed}
      errorMessage={m.feed_load_error()}
      emptyIcon={emptyIcon}
      emptyMessage={emptyMessage}
      isEmpty={posts.length === 0}
      emptyAction={emptyAction}
      listClassName="space-y-4"
      loadingFallback={<FeedSkeleton />}
    >
      {posts.map((post, index) => (
        // The same post can be two legitimate timeline events — authored at
        // its own timestamp and reposted later. Key by event identity, not the
        // original post id, so React never reuses one card for the other.
        //
        // The first card's images load eagerly: on a cold load that is the
        // image the LCP lands on, and `loading="lazy"` was deferring it behind
        // layout (measured ~700 ms on the authenticated home feed).
        <PostCard
          key={`${post.id}:${post.repostedBy?.id ?? "post"}:${post.repostedBy?.repostedAt.toISOString() ?? ""}`}
          post={post}
          showParentContext={showParentContext}
          priorityImages={index === 0}
          gameMentions={gameMentions}
        />
      ))}
    </PaginatedState>
  );
}

/**
 * Three placeholder cards that reserve roughly the first page's height while
 * it loads (0.4.0 CLS fix): the spinner they replaced was ~100 px tall, so
 * the footer and everything under it jumped a full screenful when the feed
 * landed — the largest measured layout shift on the cold authenticated load.
 * A fixed approximation rather than a per-post mirror: post heights genuinely
 * vary, and the residual shift of a card being taller or shorter than its
 * placeholder is an order of magnitude smaller than spinner-to-feed was.
 *
 * `aria-hidden`: it paints structure, not information — the loading state it
 * stands for is already conveyed by the page not answering.
 *
 * Exported for the surfaces whose rows are post cards but which do not mount
 * a `PostFeed` (the home scope gate, the thread reply feed, search posts).
 */
export function FeedSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="border-border bg-card rounded-xl border p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
            <div className="w-full space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
          <Skeleton className="mt-4 h-40 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}
