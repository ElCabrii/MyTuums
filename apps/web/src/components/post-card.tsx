import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Heart } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useSession } from "@/lib/auth-client";
import { formatRelativeTime } from "@/lib/format";
import { orpc, type Post, type PostListPage } from "@/lib/orpc";
import { handleOf, initialsOf } from "@/lib/user";

type CachedFeeds = [readonly unknown[], InfiniteData<PostListPage> | undefined][];

/**
 * A post can be cached in several feeds at once (the home timeline and its
 * author's profile), so every optimistic edit has to sweep all `post.list`
 * queries rather than one key.
 */
function useToggleLike(postId: string) {
  const queryClient = useQueryClient();
  const feedsKey = orpc.post.list.key();

  // Both mutations share one scope id, which is what makes them run in
  // serial (TanStack Query queues same-scope mutations). Without it the two
  // requests race: a quick like-then-unlike can have the *unlike* response
  // land first and the *like* response land second, so `onSuccess` below
  // reconciles from the stale one and the UI settles on "liked" while the
  // server has it unliked. Serialising also means the server applies the
  // clicks in the order they were made, so its final state is the user's
  // last intent — which is the half a client-side ordering guard can't fix.
  //
  // Scoped per post, not globally: liking two different posts in quick
  // succession has no ordering relationship and shouldn't queue.
  const scope = { id: `post-like:${postId}` };

  const updatePost = (postId: string, update: (post: Post) => Post) => {
    queryClient.setQueriesData<InfiniteData<PostListPage>>({ queryKey: feedsKey }, (cached) =>
      cached
        ? {
            ...cached,
            pages: cached.pages.map((page) => ({
              ...page,
              items: page.items.map((post) => (post.id === postId ? update(post) : post)),
            })),
          }
        : cached
    );
  };

  const cachedPost = (): Post | undefined =>
    queryClient
      .getQueriesData<InfiniteData<PostListPage>>({ queryKey: feedsKey })
      .flatMap(([, data]) => data?.pages ?? [])
      .flatMap((page) => page.items)
      .find((item) => item.id === postId);

  const rollback = (snapshot: CachedFeeds) => {
    for (const [key, data] of snapshot) {
      queryClient.setQueryData(key, data);
    }
  };

  // The state the *last* click asked for. Because the two mutations are
  // serialised, responses for superseded clicks still arrive — this is what
  // lets `reconcile` tell "the server confirming what the user currently
  // wants" apart from "the server confirming a click that's already been
  // undone", and drop the latter instead of flickering through it.
  const intent = useRef<boolean | null>(null);

  // `like`/`unlike` return the authoritative count, so success reconciles from
  // the response instead of invalidating and refetching every visible feed.
  const reconcile = (result: { postId: string; likeCount: number; viewerHasLiked: boolean }) => {
    if (intent.current !== null && result.viewerHasLiked !== intent.current) return;

    updatePost(result.postId, (post) => ({
      ...post,
      likeCount: result.likeCount,
      viewerHasLiked: result.viewerHasLiked,
    }));
  };

  // Rollback lives on the per-call callbacks below rather than here, so each
  // click restores the snapshot taken at *its* click time.
  const like = useMutation({ ...orpc.post.like.mutationOptions({ onSuccess: reconcile }), scope });
  const unlike = useMutation({
    ...orpc.post.unlike.mutationOptions({ onSuccess: reconcile }),
    scope,
  });

  return () => {
    // Stop in-flight refetches from landing after the optimistic edit and
    // overwriting it with pre-mutation data.
    void queryClient.cancelQueries({ queryKey: feedsKey });
    const snapshot = queryClient.getQueriesData<InfiniteData<PostListPage>>({ queryKey: feedsKey });

    // Read the current state from the cache rather than the `post` prop: the
    // prop is a render-time snapshot, so a burst of clicks would all see the
    // same starting value and resolve to the same direction.
    const liked = !(cachedPost()?.viewerHasLiked ?? false);
    intent.current = liked;

    // Applied here rather than in `onMutate`, which for a scoped mutation
    // doesn't run until the queue reaches it — the click has to show up
    // immediately, not one round trip later.
    updatePost(postId, (post) =>
      post.viewerHasLiked === liked
        ? post
        : { ...post, viewerHasLiked: liked, likeCount: post.likeCount + (liked ? 1 : -1) }
    );

    const mutation = liked ? like : unlike;
    mutation.mutate({ postId }, { onError: () => { rollback(snapshot); } });
  };
}

export function PostCard({ post }: { post: Post }) {
  const { data: session } = useSession();
  const toggleLike = useToggleLike(post.id);

  const isSignedIn = Boolean(session?.user);
  const authorHandle = handleOf(post.author);
  const authorName = post.author.name || authorHandle || "Unknown";

  const likeButtonClass = `flex items-center gap-1.5 transition-colors ${
    post.viewerHasLiked ? "text-red-500 font-bold" : "hover:text-red-500"
  }`;
  const likeContent = (
    <>
      <Heart className={`h-4 w-4 ${post.viewerHasLiked ? "fill-red-500" : ""}`} />
      <span>{post.likeCount}</span>
    </>
  );

  return (
    <div className="p-4 sm:p-5 rounded-xl border border-border bg-card shadow-sm hover:border-primary/30 transition-colors">
      <div className="flex gap-3">
        <Avatar className="h-10 w-10 bg-background">
          <AvatarImage src={post.author.image || undefined} alt={authorName} />
          <AvatarFallback className="bg-primary text-primary-foreground font-bold text-xs">
            {initialsOf(authorName)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            {authorHandle ? (
              <Link
                to="/@{$username}"
                params={{ username: authorHandle }}
                className="flex items-center gap-1.5 hover:underline"
              >
                <span className="font-bold text-sm text-foreground truncate">{authorName}</span>
                <span className="text-xs text-muted-foreground">@{authorHandle}</span>
              </Link>
            ) : (
              <span className="font-bold text-sm text-foreground truncate">{authorName}</span>
            )}
            <span className="text-xs text-muted-foreground">
              • {formatRelativeTime(post.createdAt)}
            </span>
          </div>

          <p className="text-sm text-foreground/90 whitespace-pre-line mb-3 leading-relaxed break-words">
            {post.content}
          </p>

          <div className="flex items-center max-w-md text-xs text-muted-foreground">
            {isSignedIn ? (
              <button
                type="button"
                onClick={toggleLike}
                aria-pressed={post.viewerHasLiked}
                aria-label={post.viewerHasLiked ? "Unlike this post" : "Like this post"}
                className={likeButtonClass}
              >
                {likeContent}
              </button>
            ) : (
              // Signed out, the server would reject the like — send people to
              // log in rather than let them click into a 401.
              <Link to="/login" title="Log in to like posts" className={likeButtonClass}>
                {likeContent}
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
