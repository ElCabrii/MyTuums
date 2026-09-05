import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Bell, Trash2 } from "lucide-react";
import {
  clearAllNotificationsAtom,
  deleteNotificationAtom,
  markAllReadAtom,
  notificationsFeedAtom,
} from "@/atoms/notifications";
import { actionIcon, actionLabel } from "@/components/moderation/labels";
import { PaginatedState } from "@/components/paginated-state";
import { PostAttachmentGrid } from "@/components/post-attachment-grid";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatRelativeTime } from "@/lib/format";
import type { NotificationItem } from "@/lib/orpc";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

/**
 * The `/notifications` page (issue #259): everything that happened to the
 * viewer while they were elsewhere — likes, replies, reposts, quotes,
 * follows, follow requests (issue #328) and moderation notices — newest
 * first, keyset-paginated, no grouping and no ranking.
 *
 * Opening the page is what "read" means here: the mount effect below stamps
 * every unread row read, which is also what clears the header badge. The
 * invalidation that follows refetches the list, so the rows flip to their
 * read styling from the server's answer rather than a local patch.
 *
 * Rows are the recipient's private inbox entries (issue #330): each one can
 * be deleted, and the header clears the whole inbox behind a confirmation.
 */
export function NotificationsPage() {
  const feed = useAtomValue(notificationsFeedAtom);
  const markAllRead = useAtomValue(markAllReadAtom);
  const deleteNotification = useAtomValue(deleteNotificationAtom);
  const clearAll = useAtomValue(clearAllNotificationsAtom);
  const [clearOpen, setClearOpen] = useState(false);
  // Per-row pending ids, not the mutation's shared `isPending`: one row's
  // round trip must not disable every other row's button while the server
  // budget allows bursts.
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());
  // Same-frame double-activation guard: `deletingIds` state only disables the
  // button after a re-render, so two clicks within one frame would both fire.
  // The ref owns the guarantee because state is stale in the same frame.
  const deletingIdsRef = useRef(new Set<string>());
  // The once-per-mount guard is the ref, not the mutation state. The atom's
  // value is a fresh object on every emit (query events, pending → success
  // transitions), and on a slow machine the first `mutate`'s isPending flip
  // can land after the next effect run — both runs see `isIdle` and the call
  // fires twice (seen on a loaded self-hosted runner; harmless server-side,
  // but the guarantee is the page's, so the ref owns it). `isIdle` stays as
  // the semantic gate — never re-fire a mutation that already ran.
  const markedOnMount = useRef(false);

  useEffect(() => {
    if (!markedOnMount.current && markAllRead.isIdle) {
      markedOnMount.current = true;
      markAllRead.mutate({});
    }
  }, [markAllRead]);

  // Closing on success rather than on click, like `DeletePostDialog`: a
  // clear that fails has to leave its dialog standing with the error,
  // because the inbox behind it still holds the rows. Awaited here instead
  // of a success effect — the open flag is local `useState`, which the
  // set-state-in-effect rule forbids writing from an effect.
  const confirmClearAll = () => {
    void (async () => {
      try {
        await clearAll.mutateAsync({});
        handleClearOpenChange(false);
      } catch {
        // Stays open: `isError` below renders the failure.
      }
    })();
  };

  // Resetting the mutation when the dialog closes, like `DeletePostDialog`'s
  // unmount: otherwise a failed clear's error survives Cancel and reappears
  // on the next open before any new attempt. Closing mid-flight is refused
  // while pending: `reset()` does not abort the request, so dismissing then
  // would hide the coming failure and resurrect it as a stale error on the
  // next open.
  const handleClearOpenChange = (open: boolean) => {
    if (!open && clearAll.isPending) return;
    if (!open) clearAll.reset();
    setClearOpen(open);
  };

  // Per-row pending around `mutateAsync` (settled via the promise, not a
  // per-call callback): the page mounts the mutation observer, but the
  // promise holds regardless, and the `finally` drops exactly this row's id.
  // The page-level `isError` banner below still reports the failure.
  const handleDelete = (id: string) => {
    if (deletingIdsRef.current.has(id)) return;
    deletingIdsRef.current.add(id);
    setDeletingIds((previous) => new Set(previous).add(id));
    void deleteNotification
      .mutateAsync({ id })
      .catch(() => {})
      .finally(() => {
        deletingIdsRef.current.delete(id);
        setDeletingIds((previous) => {
          const next = new Set(previous);
          next.delete(id);
          return next;
        });
      });
  };

  const items = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold tracking-tight">{m.notifications_title()}</h1>
        {items.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setClearOpen(true)}>
            {m.notifications_clear_all()}
          </Button>
        )}
      </div>
      {deleteNotification.isError && (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="text-destructive text-xs">
            {m.notification_delete_error()}
          </p>
          <Button variant="ghost" size="sm" onClick={() => deleteNotification.reset()}>
            {m.common_close()}
          </Button>
        </div>
      )}
      <PaginatedState
        query={feed}
        errorMessage={m.notifications_load_error()}
        emptyIcon={Bell}
        emptyMessage={m.notifications_empty()}
        isEmpty={items.length === 0}
        listClassName="space-y-3"
        loadingFallback={<NotificationListSkeleton />}
      >
        {items.map((item) => (
          <NotificationRow
            key={item.id}
            item={item}
            deleting={deletingIds.has(item.id)}
            onDelete={handleDelete}
          />
        ))}
      </PaginatedState>
      <Dialog open={clearOpen} onOpenChange={handleClearOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{m.notifications_clear_all_title()}</DialogTitle>
            <DialogDescription>{m.notifications_clear_all_body()}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 px-6 pb-6">
            {clearAll.isError && (
              <p role="alert" className="text-destructive text-xs">
                {m.notifications_clear_all_error()}
              </p>
            )}
            <Button
              variant="destructive"
              className="w-full"
              disabled={clearAll.isPending}
              onClick={confirmClearAll}
            >
              {m.notifications_clear_all()}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              disabled={clearAll.isPending}
              onClick={() => handleClearOpenChange(false)}
            >
              {m.common_cancel()}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Three placeholder rows that mirror `NotificationRow` (avatar + text lines)
 * while the inbox loads.
 *
 * `aria-hidden`: it paints structure, not information.
 */
export function NotificationListSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="border-border bg-card flex items-start gap-3 rounded-xl border p-4"
        >
          <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The row's fixed frame — tone varies with read state, everything else does not. */
function rowClassName(item: NotificationItem): string {
  return [
    "flex items-start gap-3 rounded-xl border p-4 shadow-sm transition-colors",
    item.read ? "border-border bg-card hover:border-primary/30" : "border-primary/40 bg-primary/5",
  ].join(" ");
}

/** One notification: who did what, when, and — while unread — a marker dot. */
function NotificationRow({
  item,
  deleting,
  onDelete,
}: {
  item: NotificationItem;
  deleting: boolean;
  onDelete: (id: string) => void;
}) {
  const locale = getLocale();
  const actor = item.actor;
  const handle = handleOf(actor);
  const displayName = actor?.name || handle || m.user_unknown();
  const when = formatRelativeTime(item.createdAt, locale, m.post_just_now());
  const reason = item.action?.reason ?? null;

  // The delete button sits BESIDE the link, never inside it: a button in a
  // link is invalid interactive nesting, and the row must stay clickable to
  // its post or profile while offering its own dismiss action.
  const actions = (
    <span className="flex shrink-0 items-center gap-1.5">
      {!item.read && (
        <>
          <span className="bg-primary sr-only">{m.notifications_unread_label()}</span>
          <span className="bg-primary inline-block h-2 w-2 rounded-full" aria-hidden="true" />
        </>
      )}
      <button
        type="button"
        aria-label={m.notification_delete()}
        title={m.notification_delete()}
        disabled={deleting}
        onClick={() => onDelete(item.id)}
        className="text-muted-foreground hover:text-destructive rounded p-1 transition-colors disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
    </span>
  );

  const content = (
    <>
      {actor ? (
        <UserAvatar
          user={actor}
          alt={displayName}
          className="bg-background h-10 w-10 shrink-0"
          fallbackClassName="bg-primary text-primary-foreground text-xs font-bold"
        />
      ) : (
        <span
          aria-hidden="true"
          className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        >
          {item.action ? actionIcon(item.action.code) : <Bell className="h-5 w-5" />}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm">{notificationText(item, displayName)}</p>
        {/*
          The post preview (issue #281): the liked post's words, or the reply
          itself — `postId` already points at the row worth quoting. A
          single truncated line plus compact thumbnails, both absent when the
          server has nothing to show: follow and moderation rows carry no
          post, and a moderator-removed post previews nothing (the same
          tombstone rule every post surface follows).
        */}
        {item.postContent && (
          <p className="text-muted-foreground mt-0.5 truncate text-xs">{item.postContent}</p>
        )}
        {item.postAttachments.length > 0 && (
          <div className="mt-1.5">
            <PostAttachmentGrid attachments={item.postAttachments} compact />
          </div>
        )}
        {reason && (
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {m.notification_reason({ reason })}
          </p>
        )}
        <time
          dateTime={item.createdAt.toISOString()}
          className="text-muted-foreground mt-0.5 block text-xs"
        >
          {when}
        </time>
      </div>
    </>
  );

  // A follow or follow request leads to the follower's profile; a like,
  // reply, repost or quote to the post it happened on (the reply or quote
  // itself — the conversation to rejoin, or what the quoter said; a repost
  // to the recipient's own post). A moderation notice leads to its post when
  // it had one — and only while that post still exists, which unlike the
  // like/reply rows is not covered by the server's tombstone filter (a
  // moderation row carries the action, not the post) — and nowhere for
  // account-level actions: there is no account-sanction page to send them to.
  if ((item.type === "follow" || item.type === "follow_request") && handle) {
    return (
      <div className={rowClassName(item)}>
        <Link
          to="/@{$username}"
          params={{ username: handle }}
          className="flex min-w-0 flex-1 items-start gap-3"
        >
          {content}
        </Link>
        {actions}
      </div>
    );
  }

  const postId =
    item.type === "moderation"
      ? item.targetPostDeletedAt
        ? null
        : (item.action?.targetPostId ?? null)
      : item.postId;
  if (postId) {
    return (
      <div className={rowClassName(item)}>
        <Link
          to="/post/$postId"
          params={{ postId }}
          className="flex min-w-0 flex-1 items-start gap-3"
        >
          {content}
        </Link>
        {actions}
      </div>
    );
  }

  return (
    <div className={rowClassName(item)}>
      <div className="flex min-w-0 flex-1 items-start gap-3">{content}</div>
      {actions}
    </div>
  );
}

/**
 * The recipient-voiced sentence a row reads. The moderation arm reuses
 * `actionLabel`'s contract-and-fallback shape with first-person copy — the
 * audit log's "User suspended" is the moderator's voice, not the notified
 * user's.
 */
function notificationText(item: NotificationItem, displayName: string): string {
  switch (item.type) {
    case "like":
      return m.notification_like({ name: displayName });
    case "reply":
      return m.notification_reply({ name: displayName });
    case "repost":
      return m.notification_repost({ name: displayName });
    case "quote":
      return m.notification_quote({ name: displayName });
    case "follow":
      return m.notification_follow({ name: displayName });
    case "follow_request":
      return m.notification_follow_request({ name: displayName });
    case "moderation":
      return moderationText(item.action?.code);
  }
}

function moderationText(code: string | undefined): string {
  switch (code) {
    case "post_removed":
      return m.notification_moderation_post_removed();
    case "post_restored":
      return m.notification_moderation_post_restored();
    case "user_suspended":
      return m.notification_moderation_user_suspended();
    case "user_unsuspended":
      return m.notification_moderation_user_unsuspended();
    case "user_banned":
      return m.notification_moderation_user_banned();
    case "user_unbanned":
      return m.notification_moderation_user_unbanned();
    case "role_changed":
      return m.notification_moderation_role_changed();
    case "appeal_resolved":
      return m.notification_moderation_appeal_resolved();
    // An unclassified code renders the audit log's own label (itself falling
    // back to the raw code) — same reasoning as `actionLabel`.
    default:
      return code ? actionLabel(code) : m.notifications_title();
  }
}
