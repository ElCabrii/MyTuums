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

const routeApi = getRouteApi("/post/$postId");

export function ThreadPage() {
  const { postId } = routeApi.useParams();
  const signedIn = useAtomValue(isSignedInAtom);
  const threadQuery = useAtomValue(threadAtomFamily(postId));

  if (threadQuery.isPending) {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
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
      <ProfileMessage icon={FileQuestion} title="Post not found">
        <p className="text-sm text-muted-foreground mb-4">
          This post may have been deleted, or the link may be wrong.
        </p>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/" />}>
          Back to home
        </Button>
      </ProfileMessage>
    ) : (
      <ProfileMessage icon={AlertCircle} title="Could not load this post">
        <p className="text-sm text-muted-foreground mb-4">
          {threadQuery.error.message || "Something went wrong."}
        </p>
        <Button variant="outline" size="sm" onClick={() => void threadQuery.refetch()}>
          Try again
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
          render={<Link to="/" aria-label="Back to home" />}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-lg font-bold tracking-tight">Post</h1>
      </div>

      {ancestors.length > 0 && (
        <div className="space-y-0">
          {truncated && (
            <p className="px-1 pb-2 text-xs text-muted-foreground flex items-center gap-1.5">
              <MoreHorizontal className="h-4 w-4" />
              <span>
                This conversation continues above the {THREAD_ANCESTOR_MAX} replies shown.
              </span>
            </p>
          )}
          {/* The left rule is what makes the chain read as one conversation
              rather than a stack of unrelated cards. */}
          <div className="border-l-2 border-border pl-3 ml-5 space-y-0 divide-y divide-border/60">
            {ancestors.map((ancestor) => (
              <PostCard key={ancestor.id} post={ancestor} variant="ancestor" />
            ))}
          </div>
        </div>
      )}

      <PostCard post={post} variant="focused" />

      {signedIn ? (
        <ReplyComposer parentId={post.id} replyingTo={authorHandle} />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Log in to reply.</p>
          <Button size="sm" nativeButton={false} render={<Link to="/login" />}>
            Log in
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2 pt-2 pb-2 border-b border-border">
        <h2 className="text-sm font-bold text-foreground">
          {post.replyCount === 1 ? "1 reply" : `${String(post.replyCount)} replies`}
        </h2>
      </div>

      {/*
        The reply list is `post.list` scoped by parent, not a bespoke query —
        see the `parentId` input in packages/api/src/posts.ts for why. It
        means these cards share the same cache the optimistic like sweeps.
      */}
      <PostFeed
        feedAtom={postFeedAtom({ feed: "global", parentId: post.id })}
        emptyMessage="No replies yet. Be the first to reply."
      />
    </div>
  );
}
