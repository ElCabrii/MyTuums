import { messagePreview } from "@/lib/message-preview";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { getLocale } from "@/paraglide/runtime.js";
import { Inbox, MailQuestion, Users } from "lucide-react";
import { conversationsAtom, messagesUnreadAtom } from "@/atoms/messages";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PaginatedState } from "@/components/paginated-state";
import { documentTitle } from "@/lib/document-head";
import type { ConversationItem } from "@/lib/orpc";
import { formatRelativeTime } from "@/lib/format";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

/**
 * The `/messages` shell (issue #408): the conversation list beside the open
 * thread. Desktop renders both panes; mobile stacks — the list fills the
 * route, and a thread opens as its own sub-route over it.
 */
export function MessagesPage() {
  // The placeholder fills the right half only when no sub-route is open —
  // with a thread, a request page or the draft composer mounted, the outlet
  // owns that half outright.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const threadRouteOpen = pathname !== "/messages";

  // The tab mirrors the header badge live: "(3) Messages - MyTuums" while
  // mail is owed, plain otherwise. Every route in this tree ships the same
  // static head, so the prefix re-stamps on in-tree navigation (where the
  // router re-applies that head) as well as on count changes.
  const unread = useAtomValue(messagesUnreadAtom);
  const unreadCount = unread.data?.unreadCount ?? 0;
  useEffect(() => {
    document.title =
      unreadCount > 0
        ? `(${unreadCount}) ${documentTitle(m.messages_title())}`
        : documentTitle(m.messages_title());
  }, [unreadCount, pathname]);

  return (
    // Fixed to the visible area — the shell publishes both chrome heights as
    // `--header-height` and `--mobile-nav-height` — so the conversation list
    // and the thread each scroll independently inside their own panes and the
    // route itself never scrolls. The route is an app surface rather than a
    // document, which is also why the site footer sits it out (`__root`).
    //
    // Full-bleed on purpose (unlike the document pages' centered column): a
    // messenger is a two-pane app, and every desktop messenger spends the
    // whole window on it.
    <div className="grid h-[calc(100dvh-var(--header-height)-var(--mobile-nav-height))] w-full flex-1 grid-cols-1 grid-rows-1 overflow-hidden md:grid-cols-[minmax(300px,380px)_1fr]">
      {/* A thread, request page or draft composer replaces the list on mobile
          (the thread header's back arrow is the way back); desktop keeps both
          panes side by side. */}
      <aside
        className={`border-border min-h-0 flex-col border-b md:border-r md:border-b-0 ${
          threadRouteOpen ? "hidden md:flex" : "flex"
        }`}
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-6 pb-3">
          <h1 className="text-lg font-bold tracking-tight">{m.messages_title()}</h1>
        </div>
        <RequestsEntry />
        <ConversationList />
      </aside>
      <section className="min-h-0 min-w-0">
        {!threadRouteOpen && (
          <div className="hidden md:block">
            <ThreadPlaceholder />
          </div>
        )}
        <Outlet />
      </section>
    </div>
  );
}

function ThreadPlaceholder() {
  return (
    <div className="text-muted-foreground flex h-full min-h-64 flex-col items-center justify-center gap-2 p-8">
      <Inbox className="h-8 w-8" aria-hidden="true" />
      <p className="text-sm">{m.messages_placeholder()}</p>
    </div>
  );
}

/** The pinned requests entry at the top of the list, with its own count. */
function RequestsEntry() {
  const unread = useAtomValue(messagesUnreadAtom);
  const count = unread.data?.requestCount ?? 0;
  return (
    <div className="px-4 pb-2">
      <Button
        variant="secondary"
        className="w-full justify-between"
        render={
          <Link
            to="/messages/requests"
            className="no-underline"
            aria-label={
              count > 0 ? m.messages_requests_entry_with_count({ count }) : m.messages_requests()
            }
          />
        }
      >
        <span className="flex items-center gap-2">
          <MailQuestion className="h-4 w-4" aria-hidden="true" />
          {m.messages_requests()}
        </span>
        {count > 0 && (
          <span className="bg-primary text-primary-foreground rounded-full px-2 py-0.5 text-xs font-semibold">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </Button>
    </div>
  );
}

/** The inbox rows, keyset-paginated inside the four-state shell. */
function ConversationList() {
  const feed = useAtomValue(conversationsAtom);
  const items = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-6">
      <PaginatedState
        query={feed}
        errorMessage={m.messages_load_error()}
        emptyIcon={Users}
        emptyMessage={m.messages_empty()}
        isEmpty={items.length === 0}
        listClassName="space-y-2"
        loadingFallback={<ConversationListSkeleton />}
      >
        {items.map((item) => (
          <ConversationRow key={item.conversationId} item={item} />
        ))}
      </PaginatedState>
    </div>
  );
}

function ConversationListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          className="border-border bg-card flex items-center gap-3 rounded-xl border p-3"
        >
          <Skeleton className="h-10 w-10 shrink-0 rounded-full motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-3/4 motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ConversationRow({ item }: { item: ConversationItem }) {
  const locale = getLocale();
  const handle = handleOf(item.user);
  const displayName = item.user.name || handle || m.user_unknown();
  const when = formatRelativeTime(item.lastMessageAt, locale, m.post_just_now());
  const last = item.lastMessage;
  const preview = `${last?.body && last.senderId !== item.user.id ? `${m.messages_you()}: ` : ""}${messagePreview(last)}`;

  return (
    <Button
      variant="ghost"
      nativeButton={false}
      className={`h-auto w-full items-start justify-start gap-3 p-3 text-left ${
        item.unreadCount > 0 ? "border-primary/40 bg-primary/5" : ""
      }`}
      render={
        <Link to="/messages/$conversationId" params={{ conversationId: item.conversationId }} />
      }
    >
      <Avatar className="h-10 w-10 shrink-0">
        {item.user.image && <AvatarImage src={item.user.image} alt="" />}
        <AvatarFallback>{displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold">{displayName}</span>
          <span className="text-muted-foreground shrink-0 text-xs">{when}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className="text-muted-foreground line-clamp-1 flex-1 text-sm">{preview}</span>
          {item.unreadCount > 0 && (
            <span className="bg-primary text-primary-foreground shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold">
              {item.unreadCount > 99 ? "99+" : item.unreadCount}
            </span>
          )}
        </span>
      </span>
    </Button>
  );
}
