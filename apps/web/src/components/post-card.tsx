import type { MouseEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Bookmark, Heart, MessageCircle, MoreHorizontal, Repeat2 } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import { ProfileLink } from "@/components/profile-link";
import { firstLinkUrl, LinkedText } from "@/components/linked-text";
import { PostAttachmentGrid } from "@/components/post-attachment-grid";
import { PostTimestamps } from "@/components/post-timestamps";
import { PostLinkCard } from "@/components/post-link-card";
import { QuotePostIcon } from "@/components/icons/quote-post-icon";
import { toggleLikeAtomFamily } from "@/atoms/like";
import { toggleRepostAtomFamily } from "@/atoms/repost";
import { quoteDialogAtom } from "@/atoms/quote-composer";
import { toggleBookmarkAtomFamily } from "@/atoms/bookmark";
import { blockDialogAtom, reportDialogAtom } from "@/atoms/moderation";
import { deletePostDialogAtom } from "@/atoms/post-delete";
import { editPostDialogAtom } from "@/atoms/post-edit";
import { isSignedInAtom, viewerIdAtom } from "@/atoms/session";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Post } from "@/lib/orpc";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

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
 * - `focused` — the post the URL points at. Larger body text, the exact
 *   creation date and time rather than the compact relative label, and
 *   neither its timestamp nor its reply count links anywhere, because both
 *   would point at the page you are already on.
 */
type PostCardVariant = "feed" | "ancestor" | "focused";

/** The embedded quoted post's own compact author line — name and handle, linkable. */
function quotedAuthorName(quoted: NonNullable<Post["quoted"]>): string {
  return quoted.author.name || handleOf(quoted.author) || m.user_unknown();
}

/**
 * The post embedded inside a quote (issue #261): a compact, linked card that
 * degrades exactly the way the server's `quoted` projection decides —
 * removal stub, deletion stub, or "unavailable" when the quoted author is
 * hidden from the viewer. Kept non-interactive apart from its link so it
 * cannot nest action rows inside the outer card's shell.
 */
function QuotedPostCard({ quoted }: { quoted: NonNullable<Post["quoted"]> }) {
  const quotedHandle = handleOf(quoted.author);
  const authorName = quotedAuthorName(quoted);

  if (quoted.removed) {
    return (
      <div className="border-border/60 bg-muted/30 mb-3 rounded-lg border p-3">
        <p className="text-muted-foreground text-sm">{m.moderation_post_removed_stub()}</p>
        {quoted.removedReason && (
          <>
            <p className="text-foreground/80 mt-1 text-sm">
              {m.moderation_post_removed_reason({ reason: quoted.removedReason })}
            </p>
            {/* `removedReason` is original-author-only, so its presence gates
                the same appeal capability the original post's own stub shows. */}
            <Link
              to="/appeal"
              search={{ postId: quoted.id }}
              className="text-primary mt-1 inline-block text-xs hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {m.moderation_post_removed_appeal()}
            </Link>
          </>
        )}
      </div>
    );
  }

  if (quoted.deleted) {
    return (
      <div className="border-border/60 bg-muted/30 mb-3 rounded-lg border p-3">
        <p className="text-muted-foreground text-sm">{m.post_deleted_stub()}</p>
      </div>
    );
  }

  return (
    <div className="border-border bg-muted/20 mb-3 rounded-lg border p-3">
      {/* Only the compact header links to the quoted permalink. The body can
          contain LinkedText anchors and attachment-viewer buttons, so making
          the whole card a link would create invalid nested interactive
          controls and ambiguous keyboard behavior. */}
      <Link
        to="/post/$postId"
        params={{ postId: quoted.id }}
        className="mb-1 flex flex-wrap items-center gap-1.5 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-foreground truncate text-sm font-bold">{authorName}</span>
        {quotedHandle && <span className="text-muted-foreground text-xs">@{quotedHandle}</span>}
      </Link>
      {quoted.content && (
        <p className="text-foreground/90 text-sm leading-relaxed break-words whitespace-pre-line">
          <LinkedText text={quoted.content} />
        </p>
      )}
      <PostAttachmentGrid attachments={quoted.attachments} />
    </div>
  );
}

/**
 * One post rendered as a card — author link, timestamp, content, and the
 * like/reply actions — in the `feed`, `ancestor` or `focused` variants (see
 * `PostCardVariant`).
 */
export function PostCard({
  post,
  variant = "feed",
  showParentContext = true,
}: {
  post: Post;
  variant?: PostCardVariant;
  /** Whether to render the immediate-parent preview; feed lists choose their surface explicitly. */
  showParentContext?: boolean;
}) {
  const navigate = useNavigate();
  const isSignedIn = useAtomValue(isSignedInAtom);
  // `viewerIdAtom`, not `viewerAtom`: the card only needs "is this my post?",
  // and the full user object gets a new identity on every session refresh —
  // reading it would re-render every visible card for nothing.
  const viewerId = useAtomValue(viewerIdAtom);
  const toggleLike = useSetAtom(toggleLikeAtomFamily(post.id));
  const toggleRepost = useSetAtom(toggleRepostAtomFamily(post.id));
  const setQuoteDialog = useSetAtom(quoteDialogAtom);
  const toggleBookmark = useSetAtom(toggleBookmarkAtomFamily(post.id));
  const setReportDialog = useSetAtom(reportDialogAtom);
  const setBlockDialog = useSetAtom(blockDialogAtom);
  const setDeleteDialog = useSetAtom(deletePostDialogAtom);
  const setEditDialog = useSetAtom(editPostDialogAtom);
  const authorHandle = handleOf(post.author);
  const authorName = post.author.name || authorHandle || m.user_unknown();
  const parentAuthorName = post.parent
    ? post.parent.author.name || handleOf(post.parent.author) || m.user_unknown()
    : null;
  const isOwnPost = viewerId === post.author.id;
  const isFocused = variant === "focused";
  // Both tombstones hide the content and take the actions away with it — the
  // server nulls `content` for either (see `postSelection`), so there is
  // nothing left to like or reply to. A blocked original inside a repost event
  // is unavailable on the same terms: attribution stays, original identity and
  // actions do not. Which stub renders still depends on which one it is; only
  // "is it gone" is shared.
  const isGone = post.removed || post.deleted || post.unavailable;
  // The one URL a post may preview (issue #260): the first the linkifier
  // recognizes, normalized exactly as the inline anchor renders it. Computed
  // once here so the card component mounts only when there is something to
  // ask about. A tombstoned post has null content, hence no first URL, hence
  // no card — the guard is the `content` check itself.
  const linkPreviewUrl = post.content ? firstLinkUrl(post.content) : null;
  // A post already gone has nothing left to edit or delete, so both items
  // drop rather than being offered as no-ops the server would refuse anyway.
  const canEdit = isOwnPost && !isGone;
  // Only top-level posts can be reposted. The server accepts a repost of a
  // reply, but no shipped surface can show that event — the home feeds'
  // repost arm excludes replies (`kind: "posts"` filters the original's
  // `parentId`, and profile feeds run no repost arm at all) — so the control
  // would be a dead end: counted, never rendered anywhere.
  const canRepost = !post.parentId;

  const handleCardClick = (e: MouseEvent<HTMLDivElement>) => {
    if (isFocused || post.unavailable) return;
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

  // A bookmark is private state, so the control carries no count — only its
  // own pressed state. The optimistic flip in `atoms/bookmark.ts` is the
  // feedback, same as the like control.
  const bookmarkButtonClass = `flex items-center gap-1.5 transition-colors ${
    post.viewerHasBookmarked ? "text-primary font-bold" : "hover:text-primary"
  }`;
  const bookmarkContent = (
    <Bookmark className={`h-4 w-4 ${post.viewerHasBookmarked ? "fill-primary" : ""}`} />
  );

  const replyLinkClass = "flex items-center gap-1.5 transition-colors hover:text-primary";
  const replyContent = (
    <>
      <MessageCircle className="h-4 w-4" />
      <span>{post.replyCount}</span>
    </>
  );

  const repostButtonClass = `flex items-center gap-1.5 transition-colors ${
    post.viewerHasReposted ? "text-primary font-bold" : "hover:text-primary"
  }`;
  const repostContent = (
    <>
      <Repeat2 className={`h-4 w-4 ${post.viewerHasReposted ? "stroke-[2.5]" : ""}`} />
      <span>{post.repostCount}</span>
    </>
  );

  const containerClass =
    variant === "ancestor"
      ? `px-1 py-2 ${post.unavailable ? "" : "cursor-pointer"}`
      : `p-4 sm:p-5 rounded-xl border border-border bg-card shadow-sm transition-colors ${
          isFocused || post.unavailable ? "" : "hover:border-primary/30 cursor-pointer"
        }`;

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
      {post.repostedBy && (
        // A feed event's attribution: who amplified this post, and the event
        // is theirs — the author line below stays the ORIGINAL's. Rendered in
        // every variant, because it is event context, not card chrome.
        <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs">
          <Repeat2 className="h-3.5 w-3.5" />
          {m.post_reposted_by({
            name:
              post.repostedBy.name ||
              (post.repostedBy.username ?? post.repostedBy.displayUsername) ||
              m.user_unknown(),
          })}
        </p>
      )}
      {variant === "feed" && showParentContext && post.parentId && (
        // A quiet one-line "Replying to …" above the whole card header —
        // avatar, name and timestamp included — so a profile feed of replies
        // reads as one conversation rather than a stack of boxed quotes. The
        // name stays a link to the parent thread, and a removed parent keeps
        // its inline why (author-deleted parents never reach this card).
        <p className="text-muted-foreground mb-2 text-xs">
          {post.parent ? (
            <>
              <Link
                to="/post/$postId"
                params={{ postId: post.parentId }}
                className="hover:text-foreground transition-colors hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {m.reply_parent_label({ name: parentAuthorName ?? m.user_unknown() })}
              </Link>
              {post.parent.removed && (
                <span>
                  {" · "}
                  {m.moderation_post_removed_stub()}
                </span>
              )}
            </>
          ) : (
            m.reply_parent_unavailable()
          )}
        </p>
      )}
      <div className="flex gap-3">
        {!post.unavailable &&
          (authorHandle ? (
            <ProfileLink
              username={authorHandle}
              className="shrink-0 rounded-full transition-opacity hover:opacity-90"
              onClick={(e) => e.stopPropagation()}
            >
              {authorAvatar}
            </ProfileLink>
          ) : (
            authorAvatar
          ))}
        <div className="min-w-0 flex-1">
          {!post.unavailable && (
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              {authorHandle ? (
                <ProfileLink
                  username={authorHandle}
                  className="flex items-center gap-1.5 hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="text-foreground truncate text-sm font-bold">{authorName}</span>
                  <span className="text-muted-foreground text-xs">@{authorHandle}</span>
                </ProfileLink>
              ) : (
                <span className="text-foreground truncate text-sm font-bold">{authorName}</span>
              )}
              {/* The creation timestamp and the "Edited" marker (issue #264)
                  render as one unit — see `PostTimestamps` for why both ride
                  the same relative/exact split. `<time>` regardless of variant:
                  the rendered label differs, but the machine-readable value
                  assistive technology and tooling read is `post.createdAt`
                  either way. */}
              <PostTimestamps
                createdAt={post.createdAt}
                editedAt={post.editedAt}
                exact={isFocused}
              />

              {/* Every item here lives in a shared dialog mounted at the root
                (identity atoms — see `atoms/moderation.ts`,
                `atoms/post-delete.ts` and `atoms/post-edit.ts`), so this menu
                only has to set the target. Which items it holds is decided by
                whose post it is: Edit/Delete on the viewer's own,
                Report/Block on everyone else's — you cannot report yourself,
                and a moderator takes other people's posts down through the
                case queue, not from here. Other people's posts keep the menu
                even when removed: reporting the *author* of a removed post is
                still valid. */}
              {isSignedIn && (canEdit || !isOwnPost) && (
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
                      <>
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onClick={() =>
                            setEditDialog({
                              postId: post.id,
                              // The wire type is nullable; an image-only post
                              // edits from an empty draft, same as its stored "".
                              content: post.content ?? "",
                              attachmentCount: post.attachments.length,
                            })
                          }
                        >
                          {m.post_edit()}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer"
                          variant="destructive"
                          onClick={() => setDeleteDialog(post.id)}
                        >
                          {m.post_delete()}
                        </DropdownMenuItem>
                      </>
                    ) : (
                      <>
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onClick={() =>
                            setReportDialog({ targetType: "post", targetId: post.id, post })
                          }
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
          )}

          {post.unavailable ? (
            <div className="border-border/60 bg-muted/30 mb-3 rounded-lg border p-3">
              <p className="text-muted-foreground text-sm">{m.post_quoted_unavailable()}</p>
            </div>
          ) : post.removed ? (
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
            <>
              {/* An image-only post (issue #202) stores `content` as ""; the
                  paragraph is omitted entirely rather than leaving a blank
                  block above the attachment grid. */}
              {post.content && (
                <p
                  className={`text-foreground/90 mb-3 leading-relaxed break-words whitespace-pre-line ${
                    isFocused ? "text-base" : "text-sm"
                  }`}
                >
                  <LinkedText text={post.content} />
                </p>
              )}
              {/* The card belongs to the first URL of the text (issue #260),
                  so it renders directly beneath it — before the author's own
                  images — and only when the linkifier found one to preview.
                  Everything about resolution and refusal lives in
                  `PostLinkCard`; for a URL with no card the post is exactly
                  what it was before. */}
              {post.content && linkPreviewUrl && <PostLinkCard url={linkPreviewUrl} />}
              <PostAttachmentGrid attachments={post.attachments} />
              {/* The embedded quoted post — a reference, not a reply: rendered
                  inside the card, linked to its own permalink, and degraded by
                  the projection (stub or unavailable) rather than hidden. */}
              {post.quotedPostId &&
                (post.quoted ? (
                  <QuotedPostCard quoted={post.quoted} />
                ) : (
                  <div className="border-border/60 bg-muted/30 mb-3 rounded-lg border p-3">
                    <p className="text-muted-foreground text-sm">{m.post_quoted_unavailable()}</p>
                  </div>
                ))}
            </>
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

              {/* Offered only where its event can be shown — see `canRepost`
                  above: a reply's repost would never render anywhere. */}
              {canRepost && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRepost();
                  }}
                  aria-pressed={post.viewerHasReposted}
                  aria-label={
                    post.viewerHasReposted
                      ? m.post_unrepost({ count: String(post.repostCount) })
                      : m.post_repost({ count: String(post.repostCount) })
                  }
                  className={repostButtonClass}
                >
                  {repostContent}
                </button>
              )}

              {/* Quoting opens the app-wide dialog (mounted at the root like
                  the delete confirmation): a quote is composed from anywhere a
                  card renders, not only from the thread page. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setQuoteDialog(post);
                }}
                aria-label={m.post_quote()}
                title={m.post_quote()}
                className="hover:text-primary flex items-center gap-1.5 transition-colors"
              >
                <QuotePostIcon className="h-4 w-4" />
              </button>

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

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleBookmark();
                }}
                aria-pressed={post.viewerHasBookmarked}
                aria-label={post.viewerHasBookmarked ? m.post_unbookmark() : m.post_bookmark()}
                className={bookmarkButtonClass}
              >
                {bookmarkContent}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
