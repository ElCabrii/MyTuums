import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, MessageSquare } from "lucide-react";
import { POST_PAGE_SIZE } from "@my-tuums/api/constants";
import { Button } from "@/components/ui/button";
import { PostCard } from "@/components/post-card";
import { orpc } from "@/lib/orpc";

export function PostFeed({
  authorId,
  emptyMessage,
}: {
  /** Omit for the global timeline; set to scope the feed to one author. */
  authorId?: string;
  emptyMessage: string;
}) {
  const feed = useInfiniteQuery(
    orpc.post.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        limit: POST_PAGE_SIZE,
        ...(authorId ? { authorId } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    })
  );

  if (feed.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (feed.isError) {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="space-y-2">
          <p>{feed.error.message || "Could not load posts."}</p>
          <Button variant="outline" size="sm" onClick={() => void feed.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const posts = feed.data.pages.flatMap((page) => page.items);

  if (posts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}

      {feed.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void feed.fetchNextPage()}
            disabled={feed.isFetchingNextPage}
            className="gap-2 rounded-full"
          >
            {feed.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>Load more</span>
          </Button>
        </div>
      )}
    </div>
  );
}
