import { useState } from "react";
import { useAtomValue } from "jotai";
import { AlertCircle, Loader2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PaginatedState } from "@/components/paginated-state";
import { PostCard } from "@/components/post-card";
import { FeedSkeleton } from "@/components/post-feed";
import type { postFeedAtom } from "@/atoms/post-feed";
import { replyContinuationAtom } from "@/atoms/reply-continuation";
import type { PostListPage } from "@/lib/orpc";
import { m } from "@/paraglide/messages.js";

type DirectReplyPage = Extract<PostListPage, { continuations: unknown }>;
type ReplyContinuation = DirectReplyPage["continuations"][number];

function ShowMoreButton({ pending = false, onClick }: { pending?: boolean; onClick?: () => void }) {
  return (
    <div className="flex py-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        disabled={pending}
        className="text-primary dark:text-link gap-2 rounded-full"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
        <span>{m.thread_show_more_replies()}</span>
      </Button>
    </div>
  );
}

function LoadedContinuation({ rootPostId, cursor }: { rootPostId: string; cursor: string }) {
  const continuation = useAtomValue(replyContinuationAtom(rootPostId, cursor));

  if (continuation.isPending) return <ShowMoreButton pending />;

  if (continuation.isError) {
    return (
      <div role="alert" className="text-destructive flex items-center gap-2 py-2 text-sm">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>{continuation.error.message || m.feed_load_error()}</span>
        <Button variant="ghost" size="sm" onClick={() => void continuation.refetch()}>
          {m.common_try_again()}
        </Button>
      </div>
    );
  }

  const posts = continuation.data.pages.flatMap((page) => page.items);

  return (
    <>
      {posts.map((post) => (
        <PostCard key={post.id} post={post} variant="ancestor" />
      ))}
      {continuation.hasNextPage && (
        <ShowMoreButton
          pending={continuation.isFetchingNextPage}
          onClick={() => void continuation.fetchNextPage()}
        />
      )}
    </>
  );
}

function ReplyBranch({ continuation }: { continuation: ReplyContinuation }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-border/80 divide-border/40 my-1 ml-6 divide-y border-l-2 pl-4">
      {continuation.items.map((post) => (
        <PostCard key={post.id} post={post} variant="ancestor" />
      ))}
      {continuation.nextCursor &&
        (expanded ? (
          <LoadedContinuation
            rootPostId={continuation.rootPostId}
            cursor={continuation.nextCursor}
          />
        ) : (
          <ShowMoreButton onClick={() => setExpanded(true)} />
        ))}
    </div>
  );
}

/** Direct replies plus the original-author continuation embedded with each page. */
export function ThreadReplyFeed({
  feedAtom,
  emptyMessage,
}: {
  feedAtom: ReturnType<typeof postFeedAtom>;
  emptyMessage: string;
}) {
  const feed = useAtomValue(feedAtom);
  const conversations =
    feed.data?.pages.flatMap((page) => {
      const continuationByRoot = new Map(
        ("continuations" in page ? page.continuations : []).map((continuation) => [
          continuation.rootPostId,
          continuation,
        ]),
      );
      return page.items.map((reply) => ({
        reply,
        continuation: continuationByRoot.get(reply.id),
      }));
    }) ?? [];

  return (
    <PaginatedState
      query={feed}
      errorMessage={m.feed_load_error()}
      emptyIcon={MessageSquare}
      emptyMessage={emptyMessage}
      isEmpty={conversations.length === 0}
      listClassName="space-y-4"
      loadingFallback={<FeedSkeleton />}
    >
      {conversations.map(({ reply, continuation }) => (
        <div key={reply.id}>
          <PostCard post={reply} showParentContext={false} />
          {continuation && <ReplyBranch continuation={continuation} />}
        </div>
      ))}
    </PaginatedState>
  );
}
