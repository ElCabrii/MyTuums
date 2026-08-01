import { Link } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Heart } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { toggleLikeAtomFamily } from "@/atoms/like";
import { isSignedInAtom } from "@/atoms/session";
import { formatRelativeTime } from "@/lib/format";
import { type Post } from "@/lib/orpc";
import { handleOf, initialsOf } from "@/lib/user";

export function PostCard({ post }: { post: Post }) {
  const isSignedIn = useAtomValue(isSignedInAtom);
  const toggleLike = useSetAtom(toggleLikeAtomFamily(post.id));
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
