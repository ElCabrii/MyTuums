import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Bell } from "lucide-react";
import { markAllReadAtom, notificationsFeedAtom } from "@/atoms/notifications";
import { actionIcon, actionLabel } from "@/components/moderation/labels";
import { PaginatedState } from "@/components/paginated-state";
import { UserAvatar } from "@/components/user-avatar";
import { formatRelativeTime } from "@/lib/format";
import type { NotificationItem } from "@/lib/orpc";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

/**
 * The `/notifications` page (issue #259): everything that happened to the
 * viewer while they were elsewhere — likes, replies, reposts, quotes,
 * follows and moderation notices — newest first, keyset-paginated, no
 * grouping and no ranking.
 *
 * Opening the page is what "read" means here: the mount effect below stamps
 * every unread row read, which is also what clears the header badge. The
 * invalidation that follows refetches the list, so the rows flip to their
 * read styling from the server's answer rather than a local patch.
 */
export function NotificationsPage() {
  const feed = useAtomValue(notificationsFeedAtom);
  const markAllRead = useAtomValue(markAllReadAtom);
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

  const items = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <h1 className="text-lg font-bold tracking-tight">{m.notifications_title()}</h1>
      <PaginatedState
        query={feed}
        errorMessage={m.notifications_load_error()}
        emptyIcon={Bell}
        emptyMessage={m.notifications_empty()}
        isEmpty={items.length === 0}
        listClassName="space-y-3"
      >
        {items.map((item) => (
          <NotificationRow key={item.id} item={item} />
        ))}
      </PaginatedState>
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
function NotificationRow({ item }: { item: NotificationItem }) {
  const locale = getLocale();
  const actor = item.actor;
  const handle = handleOf(actor);
  const displayName = actor?.name || handle || m.user_unknown();
  const when = formatRelativeTime(item.createdAt, locale, m.post_just_now());
  const reason = item.action?.reason ?? null;

  const body = (
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

      {!item.read && (
        <span className="mt-1 flex shrink-0 items-center gap-1.5">
          <span className="bg-primary sr-only">{m.notifications_unread_label()}</span>
          <span className="bg-primary inline-block h-2 w-2 rounded-full" aria-hidden="true" />
        </span>
      )}
    </>
  );

  // A follow leads to the follower's profile; a like, reply, repost or quote
  // to the post it happened on (the reply or quote itself — the conversation
  // to rejoin, or what the quoter said; a repost to the recipient's own
  // post). A moderation notice leads to its post when it had one — and only while
  // that post still exists, which unlike the like/reply rows is not covered
  // by the server's tombstone filter (a moderation row carries the action,
  // not the post) — and nowhere for account-level actions: there is no
  // account-sanction page to send them to.
  if (item.type === "follow" && handle) {
    return (
      <Link to="/@{$username}" params={{ username: handle }} className={rowClassName(item)}>
        {body}
      </Link>
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
      <Link to="/post/$postId" params={{ postId }} className={rowClassName(item)}>
        {body}
      </Link>
    );
  }

  return <div className={rowClassName(item)}>{body}</div>;
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
