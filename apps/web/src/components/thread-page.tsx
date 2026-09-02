import { getRouteApi, Link, useLocation } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ORPCError } from "@orpc/client";
import { AlertCircle, ArrowLeft, FileQuestion, Loader2, MoreHorizontal } from "lucide-react";
import { THREAD_ANCESTOR_MAX } from "@my-tuums/api/constants";
import { Button } from "@/components/ui/button";
import { PostCard } from "@/components/post-card";
import { ThreadReplyFeed } from "@/components/thread-reply-feed";
import { ProfileMessage } from "@/components/profile-message";
import { ReplyComposer } from "@/components/reply-composer";
import { isSignedInAtom } from "@/atoms/session";
import { postFeedAtom } from "@/atoms/post-feed";
import { threadAtomFamily } from "@/atoms/thread";
import { useDocumentHead } from "@/hooks/use-document-head";
import { postPageDescription, postPageName } from "@/lib/document-head";
import { sanitizeRedirect } from "@/lib/redirect";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

const routeApi = getRouteApi("/post/$postId");

/**
 * The `/post/$postId` page: the ancestor chain above the focused post, the
 * post itself, the reply composer, and the reply feed. Since 0.4.0 this is
 * the app's PUBLIC page — a signed-out visitor reads the thread (the
 * anonymous read modes of `post.thread`/`post.list`), sees the reply and
 * like counts as plain text, and is offered the sign-in link instead of the
 * composer (which self-gates to null without a session anyway).
 */
export function ThreadPage() {
  const { postId } = routeApi.useParams();
  const { href } = useLocation();
  const signedIn = useAtomValue(isSignedInAtom);
  const threadQuery = useAtomValue(threadAtomFamily(postId));
  const focusedPost = threadQuery.data?.post;
  useDocumentHead(postPageName(focusedPost?.content), postPageDescription(focusedPost?.content));

  if (threadQuery.isPending) {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <Loader2 className="text-primary dark:text-link h-8 w-8 animate-spin motion-reduce:animate-none" />
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
        <p className="text-muted-foreground mb-4 text-sm">{m.post_not_found_hint()}</p>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/" />}>
          {m.common_back_to_home()}
        </Button>
      </ProfileMessage>
    ) : (
      <ProfileMessage icon={AlertCircle} title={m.post_load_error()}>
        <p className="text-muted-foreground mb-4 text-sm">
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
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
      <div className="border-border flex items-center gap-2 border-b pb-2">
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
            <p className="text-muted-foreground flex items-center gap-1.5 px-1 pb-2 text-xs">
              <MoreHorizontal className="h-4 w-4" />
              <span>{m.thread_truncated({ count: String(THREAD_ANCESTOR_MAX) })}</span>
            </p>
          )}
          {/* Twitter style connecting line for ancestors */}
          <div className="border-border/80 divide-border/40 my-1 ml-6 space-y-0 divide-y border-l-2 pl-4">
            {ancestors.map((ancestor) => (
              <PostCard key={ancestor.id} post={ancestor} variant="ancestor" />
            ))}
          </div>
        </div>
      )}

      <PostCard post={post} variant="focused" priorityImages />

      {/* Twitter-style reply section header & composer */}
      <div className="border-border/60 space-y-4 border-t pt-4">
        <div className="flex items-center gap-2 pb-1">
          <h2 className="text-foreground text-sm font-semibold">
            {post.replyCount === 1
              ? m.reply_count_one({ count: String(post.replyCount) })
              : m.reply_count_many({ count: String(post.replyCount) })}
          </h2>
        </div>

        {/* The composer self-gates to null for a signed-out visitor; the
            prompt in its place is the one thing this public page asks of a
            reader who cannot interact yet. */}
        {signedIn ? (
          <ReplyComposer parentId={post.id} replyingTo={authorHandle} />
        ) : (
          <p className="text-muted-foreground border-border/60 rounded-lg border border-dashed p-4 text-sm">
            <Link
              to="/login"
              search={{ redirect: sanitizeRedirect(href) ?? undefined }}
              className="text-link font-medium underline underline-offset-2"
            >
              {m.auth_login_link()}
            </Link>{" "}
            {m.thread_sign_in_prompt()}
          </p>
        )}

        {/* Reply feed container */}
        <div className="divide-border/50 divide-y pt-2">
          <ThreadReplyFeed
            feedAtom={postFeedAtom({ feed: "global", parentId: post.id })}
            emptyMessage={m.reply_empty()}
          />
        </div>
      </div>
    </div>
  );
}
