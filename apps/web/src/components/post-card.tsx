import type { MouseEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Heart, MessageCircle, MoreHorizontal } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import { MentionText } from "@/components/mention-text";
import { toggleLikeAtomFamily } from "@/atoms/like";
import { blockDialogAtom, reportDialogAtom } from "@/atoms/moderation";
import { deletePostDialogAtom } from "@/atoms/post-delete";
import { isSignedInAtom, viewerIdAtom } from "@/atoms/session";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelativeTime } from "@/lib/format";
import type { Post } from "@/lib/orpc";
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
export function PostCard({ post, variant = "feed" }: { post: Post; variant?: PostCardVariant }) {
  const navigate = useNavigate();
  const isSignedIn = useAtomValue(isSignedInAtom);
  // `viewerIdAtom`, not `viewerAtom`: the card only needs "is this my post?",
  // and the full user object gets a new identity on every session refresh —
  // reading it would re-render every visible card for nothing.
  const viewerId = useAtomValue(viewerIdAtom);
  const toggleLike = useSetAtom(toggleLikeAtomFamily(post.id));
  const setReportDialog = useSetAtom(reportDialogAtom);
  const setBlockDialog = useSetAtom(blockDialogAtom);
  const setDeleteDialog = useSetAtom(deletePostDialogAtom);
  const authorHandle = handleOf(post.author);
  const authorName = post.author.name || authorHandle || m.user_unknown();
  const isOwnPost = viewerId === post.author.id;
  const isFocused = variant === "focused";
  // Both tombstones hide the content and take the actions away with it — the
  // server nulls `content` for either (see `postSelection`), so there is
  // nothing left to like or reply to. Which stub renders still depends on
  // which one it is; only "is it gone" is shared.
  const isGone = post.removed || post.deleted;
  // A post already gone has nothing left to delete, so the item is dropped
  // rather than offered as a no-op the server would refuse anyway.
  const canDelete = isOwnPost && !isGone;

  const handleCardClick = (e: MouseEvent<HTMLDivElement>) => {
    if (isFocused) return;
    const target = e.target;
    if (target instanceof Element && target.closest("a, button, [role='button']")) return;
    void navigate({ to: "/post/$postId", params: { postId: post.id } });
  };

  const likeButtonClass = `flex items-center gap-1.5 transition-colors ${
    post.viewerHasLiked ? "text-destructive font-bold" : "hover:text-destructive"
  }`;
  const likeContent = (
    <>
      <Heart className={`h-4 w-4 ${post.viewerHasLiked ? "fill-destructive" : ""}`} />
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
      className="bg-background h-10 w-10"
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
            className="shrink-0 rounded-full transition-opacity hover:opacity-90"
            onClick={(e) => e.stopPropagation()}
          >
            {authorAvatar}
          </Link>
        ) : (
          authorAvatar
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {authorHandle ? (
              <Link
                to="/@{$username}"
                params={{ username: authorHandle }}
                className="flex items-center gap-1.5 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-foreground truncate text-sm font-bold">{authorName}</span>
                <span className="text-muted-foreground text-xs">@{authorHandle}</span>
              </Link>
            ) : (
              <span className="text-foreground truncate text-sm font-bold">{authorName}</span>
            )}
            <span className="text-muted-foreground text-xs">• {timestamp}</span>

            {/* Every item here lives in a shared dialog mounted at the root
                (identity atoms — see `atoms/moderation.ts` and
                `atoms/post-delete.ts`), so this menu only has to set the
                target. Which items it holds is decided by whose post it is:
                Delete on the viewer's own, Report/Block on everyone else's —
                you cannot report yourself, and a moderator takes other
                people's posts down through the case queue, not from here.
                Other people's posts keep the menu even when removed:
                reporting the *author* of a removed post is still valid. */}
            {isSignedIn && (canDelete || !isOwnPost) && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={m.moderation_kebab()}
                  title={m.moderation_kebab()}
                  // The card shell navigates to the thread on click (see
                  // `handleCardClick` below) — like every other control inside
                  // the card, the kebab must not let its click bubble there,
                  // or "More" would also navigate.
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring ml-auto flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="min-w-44"
                  // The popup is portaled to <body>, but React events still
                  // bubble through the React tree — which passes through this
                  // card's clickable shell. Without this, clicking a menu item
                  // would also fire `handleCardClick` and navigate to the
                  // thread (the trigger itself already stops propagation in
                  // its own click, see above).
                  onClick={(e) => e.stopPropagation()}
                >
                  {isOwnPost ? (
                    <DropdownMenuItem
                      className="cursor-pointer"
                      variant="destructive"
                      onClick={() => setDeleteDialog(post.id)}
                    >
                      {m.post_delete()}
                    </DropdownMenuItem>
                  ) : (
                    <>
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={() => setReportDialog({ targetType: "post", targetId: post.id })}
                      >
                        {m.moderation_kebab_report_post()}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={() =>
                          setReportDialog({ targetType: "user", targetId: post.author.id })
                        }
                      >
                        {m.moderation_kebab_report_author()}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="cursor-pointer"
                        variant="destructive"
                        onClick={() =>
                          setBlockDialog({
                            userId: post.author.id,
                            handle: authorHandle ?? m.user_unknown(),
                          })
                        }
                      >
                        {m.moderation_kebab_block()}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {post.removed ? (
            /* The removal stub. `removedReason` is author-only (the server
                nulls it for everyone else), so its presence is also what gates
                the appeal link — only the author can appeal from here. */
            <div className="border-border/60 bg-muted/30 mb-3 space-y-1.5 rounded-lg border p-3">
              <p className="text-muted-foreground text-sm">{m.moderation_post_removed_stub()}</p>
              {post.removedReason && (
                <p className="text-foreground/80 text-sm">
                  {m.moderation_post_removed_reason({ reason: post.removedReason })}
                </p>
              )}
              {post.removedReason && (
                <Link
                  to="/appeal"
                  search={{ postId: post.id }}
                  className="text-primary inline-block text-xs hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {m.moderation_post_removed_appeal()}
                </Link>
              )}
            </div>
          ) : post.deleted ? (
            /* The author's own delete. Its own stub, not the removal one: no
                reason to state, nothing to appeal, and calling it a removal
                would tell every reader a moderator acted when none did. */
            <div className="border-border/60 bg-muted/30 mb-3 rounded-lg border p-3">
              <p className="text-muted-foreground text-sm">{m.post_deleted_stub()}</p>
            </div>
          ) : (
            <p
              className={`text-foreground/90 mb-3 leading-relaxed break-words whitespace-pre-line ${
                isFocused ? "text-base" : "text-sm"
              }`}
            >
              {/* Null only for the two tombstones, which the stub branches
                  above own; here the server guarantees content. */}
              <MentionText text={post.content ?? ""} />
            </p>
          )}

          {!isGone && (
            <div className="text-muted-foreground flex max-w-md items-center gap-6 text-xs">
              {/* Replying is a navigation, not a mutation — the composer lives
                on the thread page — so this is a link, and the focused post
                (whose composer is directly below) degrades it to plain text
                rather than linking to the page you are on. */}
              {isFocused ? (
                <span className="flex items-center gap-1.5">{replyContent}</span>
              ) : (
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
              )}

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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
