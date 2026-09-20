import { messagePreview } from "@/lib/message-preview";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { getLocale } from "@/paraglide/runtime.js";
import { MailQuestion } from "lucide-react";
import { acceptRequestAtom, declineRequestAtom, messageRequestsAtom } from "@/atoms/messages";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PaginatedState } from "@/components/paginated-state";
import type { MessageRequestItem } from "@/lib/orpc";
import { formatRelativeTime } from "@/lib/format";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

/**
 * The message-requests page (issue #408): pending first contact from people
 * the viewer does not follow. Accept moves the conversation to the inbox;
 * decline hides it silently — the sender is never told.
 */
export function MessageRequestsPage() {
  const feed = useAtomValue(messageRequestsAtom);
  const items = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    // Scrolls inside the bounded /messages pane — the route never scrolls
    // the document (see MessagesPage).
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <h1 className="text-lg font-bold tracking-tight">{m.messages_requests()}</h1>
        <p className="text-muted-foreground mt-1 mb-4 text-sm">{m.messages_requests_intro()}</p>
        <PaginatedState
          query={feed}
          errorMessage={m.messages_load_error()}
          emptyIcon={MailQuestion}
          emptyMessage={m.messages_requests_empty()}
          isEmpty={items.length === 0}
          listClassName="space-y-3"
          loadingFallback={<RequestsSkeleton />}
        >
          {items.map((item) => (
            <RequestRow key={item.conversationId} item={item} />
          ))}
        </PaginatedState>
      </div>
    </div>
  );
}

function RequestsSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="border-border bg-card flex items-start gap-3 rounded-xl border p-4"
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

function RequestRow({ item }: { item: MessageRequestItem }) {
  const locale = getLocale();
  const accept = useAtomValue(acceptRequestAtom);
  const decline = useAtomValue(declineRequestAtom);
  const handle = handleOf(item.user);
  const displayName = item.user.name || handle || m.user_unknown();
  const when = formatRelativeTime(item.lastMessageAt, locale, m.post_just_now());
  const busy = accept.isPending || decline.isPending;

  return (
    <div className="border-border bg-card flex items-start gap-3 rounded-xl border p-4">
      <Avatar className="h-10 w-10 shrink-0">
        {item.user.image && <AvatarImage src={item.user.image} alt="" />}
        <AvatarFallback>{displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          {handle ? (
            <Link
              to="/@{$username}"
              params={{ username: handle }}
              className="hover:text-primary truncate text-sm font-semibold no-underline"
            >
              {displayName}
            </Link>
          ) : (
            <span className="truncate text-sm font-semibold">{displayName}</span>
          )}
          <span className="text-muted-foreground shrink-0 text-xs">{when}</span>
        </div>
        <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
          {messagePreview(item.lastMessage)}
        </p>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            disabled={busy}
            render={
              <Link
                to="/messages/$conversationId"
                params={{ conversationId: item.conversationId }}
                className="no-underline"
              />
            }
          >
            {m.messages_requests_view()}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => accept.mutate({ conversationId: item.conversationId })}
          >
            {m.messages_requests_accept()}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => decline.mutate({ conversationId: item.conversationId })}
          >
            {m.messages_requests_decline()}
          </Button>
        </div>
      </div>
    </div>
  );
}
