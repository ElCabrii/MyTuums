import { Link } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Heart, MessageCircle } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { toggleLikeAtomFamily } from "@/atoms/like";
import { isSignedInAtom } from "@/atoms/session";
import { formatRelativeTime } from "@/lib/format";
import { type Post } from "@/lib/orpc";
import { handleOf, initialsOf } from "@/lib/user";

/**
 * How prominently a card renders. The thread page shows all three at once:
 * the ancestors leading down to the post you opened, that post, and its
 * replies.
 *
 * - `feed` — the default everywhere else, and what every existing call site
 *   gets without passing anything.
 * - `ancestor` — context above the focused post. Borderless and tighter, so
 *   the chain reads as one conversation rather than a stack of separate
 *   cards.
 * - `focused` — the post the URL points at. Larger body text, and its own
 *   timestamp is not a link, because it would link to the page you are on.
 */
type PostCardVariant = "feed" | "ancestor" | "focused";

export function PostCard({
  post,
  variant = "feed",
}: {
  post: Post;
  variant?: PostCardVariant;
}) {
  const isSignedIn = useAtomValue(isSignedInAtom);
  const toggleLike = useSetAtom(toggleLikeAtomFamily(post.id));
  const authorHandle = handleOf(post.author);
  const authorName = post.author.name || authorHandle || "Unknown";
  const isFocused = variant === "focused";

  const likeButtonClass = `flex items-center gap-1.5 transition-colors ${
    post.viewerHasLiked ? "text-red-500 font-bold" : "hover:text-red-500"
  }`;
  const likeContent = (
    <>
      <Heart className={`h-4 w-4 ${post.viewerHasLiked ? "fill-red-500" : ""}`} />
      <span>{post.likeCount}</span>
    </>
  );

  const replyLinkClass = "flex items-center gap-1.5 transition-colors hover:text-primary";
  const replyContent = (
    <>
      <MessageCircle className="h-4 w-4" />
      <span>{post.replyCount}</span>
    </>
  );

  const containerClass =
    variant === "ancestor"
      ? "px-1 py-2"
      : `p-4 sm:p-5 rounded-xl border border-border bg-card shadow-sm transition-colors ${
          isFocused ? "" : "hover:border-primary/30"
        }`;

  const timestamp = formatRelativeTime(post.createdAt);

  return (
    <div className={containerClass}>
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
            {/* The permalink. On the focused card it would point at the page
                you are already on, so it degrades to plain text there. */}
            {isFocused ? (
              <span className="text-xs text-muted-foreground">• {timestamp}</span>
            ) : (
              <Link
                to="/post/$postId"
                params={{ postId: post.id }}
                className="text-xs text-muted-foreground hover:underline"
              >
                • {timestamp}
              </Link>
            )}
          </div>

          <p
            className={`text-foreground/90 whitespace-pre-line mb-3 leading-relaxed break-words ${
              isFocused ? "text-base" : "text-sm"
            }`}
          >
            {post.content}
          </p>

          <div className="flex items-center gap-6 max-w-md text-xs text-muted-foreground">
            {/* Replying is a navigation, not a mutation — the composer lives
                on the thread page — so this is a link for everyone, signed in
                or not. What differs is where it goes: the same "don't click
                into a 401" reasoning as the like button below. */}
            {isFocused ? (
              // The composer for this post is directly below, so a link here
              // would point at the page you are already on — the same reason
              // the timestamp degrades to plain text above.
              <span className="flex items-center gap-1.5">{replyContent}</span>
            ) : isSignedIn ? (
              <Link
                to="/post/$postId"
                params={{ postId: post.id }}
                title="Reply to this post"
                aria-label="Reply to this post"
                className={replyLinkClass}
              >
                {replyContent}
              </Link>
            ) : (
              // `aria-label` as well as `title`: the link's content is the
              // reply count, and content wins over `title` for the accessible
              // name — without this the link announces as a bare number.
              <Link
                to="/login"
                title="Log in to reply"
                aria-label="Log in to reply"
                className={replyLinkClass}
              >
                {replyContent}
              </Link>
            )}

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
