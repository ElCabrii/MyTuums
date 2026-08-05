import { useAtomValue } from "jotai";
import { AlertCircle, Loader2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostCard } from "@/components/post-card";
import type { postFeedAtom } from "@/atoms/post-feed";
import { m } from "@/paraglide/messages.js";

/**
 * A paginated post feed with loading, retryable-error, empty and "Load more"
 * states. The query lives in the `feedAtom` prop — scope and author are
 * atom-family parameters, so this component never knows what it is showing.
 */
export function PostFeed({
  feedAtom,
  emptyMessage,
  emptyAction,
}: {
  /** The feed atom to read — parameterisation (scope, author) lives entirely in atom-land; see `atoms/post-feed.ts`. */
  feedAtom: ReturnType<typeof postFeedAtom>;
  emptyMessage: string;
  /** Rendered under `emptyMessage` — e.g. a "find people to follow" CTA. */
  emptyAction?: React.ReactNode;
}) {
  const feed = useAtomValue(feedAtom);

  if (feed.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none text-primary" />
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
          <p>{feed.error.message || m.feed_load_error()}</p>
          <Button variant="outline" size="sm" onClick={() => void feed.refetch()}>
            {m.common_try_again()}
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
        {emptyAction && <div className="mt-4 flex justify-center">{emptyAction}</div>}
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
            <span>{m.common_load_more()}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
