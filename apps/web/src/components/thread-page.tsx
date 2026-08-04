import { getRouteApi, Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ORPCError } from "@orpc/client";
import { AlertCircle, ArrowLeft, FileQuestion, Loader2, MoreHorizontal } from "lucide-react";
import { THREAD_ANCESTOR_MAX } from "@my-tuums/api/constants";
import { Button } from "@/components/ui/button";
import { PostCard } from "@/components/post-card";
import { PostFeed } from "@/components/post-feed";
import { ProfileMessage } from "@/components/profile-message";
import { ReplyComposer } from "@/components/reply-composer";
import { isSignedInAtom } from "@/atoms/session";
import { postFeedAtom } from "@/atoms/post-feed";
import { threadAtomFamily } from "@/atoms/thread";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

const routeApi = getRouteApi("/post/$postId");

export function ThreadPage() {
  const { postId } = routeApi.useParams();
  const signedIn = useAtomValue(isSignedInAtom);
  const threadQuery = useAtomValue(threadAtomFamily(postId));

  if (threadQuery.isPending) {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin motion-reduce:animate-none text-primary" />
      </div>
    );
  }

  if (threadQuery.isError) {
    // Any 4xx, not just NOT_FOUND. A well-formed id that doesn't exist gives
    // NOT_FOUND, but an id that isn't a uuid at all fails input validation
    // with BAD_REQUEST — and to a reader following a truncated or garbled
    // link those are the same fact. Showing the retry card for the second one
    // offers a "Try again" that can never succeed. This is the same 4xx
    // boundary `retryUnlessClientError` uses to decide not to retry.
    const unreachable =
      threadQuery.error instanceof ORPCError &&
      threadQuery.error.status >= 400 &&
      threadQuery.error.status < 500;

    return unreachable ? (
      <ProfileMessage icon={FileQuestion} title={m.post_not_found()}>
        <p className="text-sm text-muted-foreground mb-4">
          {m.post_not_found_hint()}
        </p>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/" />}>
          {m.common_back_to_home()}
        </Button>
      </ProfileMessage>
    ) : (
      <ProfileMessage icon={AlertCircle} title={m.post_load_error()}>
        <p className="text-sm text-muted-foreground mb-4">
          {threadQuery.error.message || m.common_something_went_wrong()}
        </p>
        <Button variant="outline" size="sm" onClick={() => void threadQuery.refetch()}>
          {m.common_try_again()}
        </Button>
      </ProfileMessage>
    );
  }

  const { post, ancestors, truncated } = threadQuery.data;
  const authorHandle = handleOf(post.author);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border">
        <Button
          variant="ghost"
          size="icon"
          nativeButton={false}
          render={<Link to="/" aria-label={m.common_back_to_home()} />}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-lg font-bold tracking-tight">{m.post_title()}</h1>
      </div>

      {ancestors.length > 0 && (
        <div className="space-y-0">
          {truncated && (
            <p className="px-1 pb-2 text-xs text-muted-foreground flex items-center gap-1.5">
              <MoreHorizontal className="h-4 w-4" />
              <span>
                {m.thread_truncated({ count: String(THREAD_ANCESTOR_MAX) })}
              </span>
            </p>
          )}
          {/* Twitter style connecting line for ancestors */}
          <div className="space-y-0 border-l-2 border-border/80 pl-4 ml-6 my-1 divide-y divide-border/40">
            {ancestors.map((ancestor) => (
              <PostCard key={ancestor.id} post={ancestor} variant="ancestor" />
            ))}
          </div>
        </div>
      )}

      <PostCard post={post} variant="focused" />

      {/* Twitter-style reply section header & composer */}
      <div className="pt-4 space-y-4 border-t border-border/60">
        <div className="flex items-center gap-2 pb-1">
          <h2 className="text-sm font-semibold text-foreground">
            {post.replyCount === 1
              ? m.reply_count_one({ count: String(post.replyCount) })
              : m.reply_count_many({ count: String(post.replyCount) })}
          </h2>
        </div>

        {signedIn ? (
          <ReplyComposer parentId={post.id} replyingTo={authorHandle} />
        ) : (
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{m.reply_signed_out()}.</p>
            <Button size="sm" nativeButton={false} render={<Link to="/login" />}>
              {m.auth_log_in()}
            </Button>
          </div>
        )}

        {/* Reply feed container */}
        <div className="pt-2 divide-y divide-border/50">
          <PostFeed
            feedAtom={postFeedAtom({ feed: "global", parentId: post.id })}
            emptyMessage={m.reply_empty()}
          />
        </div>
      </div>
    </div>
  );
}
