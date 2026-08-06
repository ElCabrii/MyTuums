import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Heart, MessageCircle, MoreHorizontal } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import { toggleLikeAtomFamily } from "@/atoms/like";
import { blockDialogAtom, reportDialogAtom } from "@/atoms/moderation";
import { isSignedInAtom, viewerAtom } from "@/atoms/session";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelativeTime } from "@/lib/format";
import { type Post } from "@/lib/orpc";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

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

/**
 * One post rendered as a card — author link, timestamp, content, and the
 * like/reply actions — in the `feed`, `ancestor` or `focused` variants (see
 * `PostCardVariant`).
 */
export function PostCard({
  post,
  variant = "feed",
}: {
  post: Post;
  variant?: PostCardVariant;
}) {
  const navigate = useNavigate();
  const isSignedIn = useAtomValue(isSignedInAtom);
  const viewer = useAtomValue(viewerAtom);
  const toggleLike = useSetAtom(toggleLikeAtomFamily(post.id));
  const setReportDialog = useSetAtom(reportDialogAtom);
  const setBlockDialog = useSetAtom(blockDialogAtom);
  const authorHandle = handleOf(post.author);
  const authorName = post.author.name || authorHandle || m.user_unknown();
  const isOwnPost = viewer?.id === post.author.id;
  const isFocused = variant === "focused";

  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isFocused) return;
    const target = e.target as HTMLElement;
    if (target.closest("a, button, [role='button']")) return;
    void navigate({ to: "/post/$postId", params: { postId: post.id } });
  };

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
      ? "px-1 py-2 cursor-pointer"
      : `p-4 sm:p-5 rounded-xl border border-border bg-card shadow-sm transition-colors ${
          isFocused ? "" : "hover:border-primary/30 cursor-pointer"
        }`;

  const timestamp = formatRelativeTime(post.createdAt, getLocale(), m.post_just_now());
  const authorAvatar = (
    <UserAvatar
      user={post.author}
      alt={authorName}
      className="h-10 w-10 bg-background"
      fallbackClassName="bg-primary text-primary-foreground font-bold text-xs"
    />
  );

  return (
    <div className={containerClass} onClick={handleCardClick}>
      <div className="flex gap-3">
        {authorHandle ? (
          <Link
            to="/@{$username}"
            params={{ username: authorHandle }}
            className="shrink-0 rounded-full hover:opacity-90 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            {authorAvatar}
          </Link>
        ) : (
          authorAvatar
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            {authorHandle ? (
              <Link
                to="/@{$username}"
                params={{ username: authorHandle }}
                className="flex items-center gap-1.5 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="font-bold text-sm text-foreground truncate">{authorName}</span>
                <span className="text-xs text-muted-foreground">@{authorHandle}</span>
              </Link>
            ) : (
              <span className="font-bold text-sm text-foreground truncate">{authorName}</span>
            )}
            <span className="text-xs text-muted-foreground">• {timestamp}</span>

            {/* Report / Block live in the shared dialogs mounted at the root
                (identity atoms — see `atoms/moderation.ts`), so this menu only
                has to set the target. Hidden on the viewer's own posts, and
                shown even on removed ones: reporting the *author* of a removed
                post is still a valid action. */}
            {isSignedIn && !isOwnPost && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={m.moderation_kebab()}
                  title={m.moderation_kebab()}
                  className="ml-auto flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem className="cursor-pointer" onClick={() => setReportDialog({ targetType: "post", targetId: post.id })}>
                    {m.moderation_kebab_report_post()}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer" onClick={() => setReportDialog({ targetType: "user", targetId: post.author.id })}>
                    {m.moderation_kebab_report_author()}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="cursor-pointer"
                    variant="destructive"
                    onClick={() => setBlockDialog({ userId: post.author.id, handle: authorHandle ?? m.user_unknown() })}
                  >
                    {m.moderation_kebab_block()}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {post.removed ? (
            /* The stub. `removedReason` is author-only (the server nulls it
                for everyone else), so its presence is also what gates the
                appeal link — only the author can appeal from here. */
            <div className="mb-3 space-y-1.5 rounded-lg border border-border/60 bg-muted/30 p-3">
              <p className="text-sm text-muted-foreground">{m.moderation_post_removed_stub()}</p>
              {post.removedReason && (
                <p className="text-sm text-foreground/80">
                  {m.moderation_post_removed_reason({ reason: post.removedReason })}
                </p>
              )}
              {post.removedReason && (
                <Link
                  to="/appeal"
                  search={{ postId: post.id }}
                  className="inline-block text-xs text-primary hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {m.moderation_post_removed_appeal()}
                </Link>
              )}
            </div>
          ) : (
            <p
              className={`text-foreground/90 whitespace-pre-line mb-3 leading-relaxed break-words ${
                isFocused ? "text-base" : "text-sm"
              }`}
            >
              {/* Null only for removed posts, which the stub branch above
                  owns; here the server guarantees content. */}
              {post.content ?? ""}
            </p>
          )}

          {!post.removed && (
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
                title={m.reply_to_post({ count: String(post.replyCount) })}
                aria-label={m.reply_to_post({ count: String(post.replyCount) })}
                className={replyLinkClass}
                onClick={(e) => e.stopPropagation()}
              >
                {replyContent}
              </Link>
            ) : (
              // `aria-label` as well as `title`, and the visible reply count
              // is `aria-hidden`: the label has no count in it, so the bare
              // number would otherwise clash with it (axe
              // label-content-name-mismatch).
              <Link
                to="/login"
                title={m.reply_signed_out()}
                aria-label={m.reply_signed_out()}
                className={replyLinkClass}
                onClick={(e) => e.stopPropagation()}
              >
                <MessageCircle className="h-4 w-4" />
                <span aria-hidden="true">{post.replyCount}</span>
              </Link>
            )}

            {isSignedIn ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLike();
                }}
                aria-pressed={post.viewerHasLiked}
                aria-label={
                  post.viewerHasLiked
                    ? m.post_unlike({ count: String(post.likeCount) })
                    : m.post_like({ count: String(post.likeCount) })
                }
                className={likeButtonClass}
              >
                {likeContent}
              </button>
            ) : (
              // Signed out, the server would reject the like — send people to
              // log in rather than let them click into a 401. `aria-label` as
              // well as `title`, and the visible like count is `aria-hidden`:
              // the label has no count in it, so the bare number would clash
              // with it (axe label-content-name-mismatch), and without the
              // label the number would win over `title` as the accessible
              // name.
              <Link
                to="/login"
                title={m.post_like_signed_out()}
                aria-label={m.post_like_signed_out()}
                className={likeButtonClass}
                onClick={(e) => e.stopPropagation()}
              >
                <Heart className={`h-4 w-4 ${post.viewerHasLiked ? "fill-red-500" : ""}`} />
                <span aria-hidden="true">{post.likeCount}</span>
              </Link>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
