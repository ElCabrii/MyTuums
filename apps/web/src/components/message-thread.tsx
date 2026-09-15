import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { getLocale } from "@/paraglide/runtime.js";
import { toast } from "sonner";
import { ArrowLeft, EyeOff, Flag, Send, Trash2 } from "lucide-react";
import {
  conversationWithFamily,
  deleteMessageAtom,
  hideConversationAtom,
  markThreadReadAtom,
  messageThreadFamily,
  sendMessageAtom,
} from "@/atoms/messages";
import type { ThreadItem } from "@/atoms/messages";
import { viewerIdAtom } from "@/atoms/session";
import { reportDialogAtom } from "@/atoms/dialog-targets";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LinkedText } from "@/components/linked-text";
import { formatRelativeTime } from "@/lib/format";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import { MESSAGE_BODY_MAX_LENGTH } from "@my-tuums/api/constants";

/**
 * One open conversation (issue #408): bubbles oldest-to-newest, safe
 * linkification via `LinkedText` (the same component posts render through),
 * sender tombstones, per-message report and delete-own actions, the
 * Enter/Shift+Enter composer, and the read acknowledgment — which fires only
 * for a foregrounded thread, through the newest DISPLAYED message.
 */
export function MessageThreadPane({ conversationId }: { conversationId: string }) {
  const thread = useAtomValue(messageThreadFamily(conversationId));
  const viewerId = useAtomValue(viewerIdAtom);
  const markRead = useAtomValue(markThreadReadAtom);
  const hide = useAtomValue(hideConversationAtom);
  const navigate = useNavigate();
  // The newest message this view has acknowledged — the loop guard for the
  // effect below, which otherwise re-fires on every refetch.
  const acknowledged = useRef<string | null>(null);

  const messages: ThreadItem[] = useMemo(
    () => thread.data?.pages.flatMap((page) => page.items) ?? [],
    [thread.data],
  );
  const oldestFirst = [...messages].reverse();
  const header = thread.data?.pages[0];
  const other = header?.user ?? null;
  const handle = handleOf(other);
  const displayName = other?.name || handle || m.user_unknown();
  const lastReadAt = header?.lastReadAt ?? null;

  // "Open and displayed means read" — but only while the document is
  // foregrounded and only through the newest message actually on screen (the
  // newest loaded one; the pane scrolls to it). A background tab must not
  // burn the reader's unread state.
  useEffect(() => {
    const newest = messages[0];
    if (
      !newest ||
      newest.pending ||
      newest.senderId === viewerId ||
      document.visibilityState !== "visible" ||
      acknowledged.current === newest.id ||
      (lastReadAt !== null && newest.createdAt <= lastReadAt)
    ) {
      return;
    }
    acknowledged.current = newest.id;
    markRead.mutate({ conversationId, lastSeenMessageId: newest.id });
  }, [messages, viewerId, lastReadAt, markRead, conversationId]);

  if (thread.isPending) {
    return <ThreadSkeleton />;
  }
  if (thread.isError) {
    return (
      <div className="text-muted-foreground flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8">
        <p role="alert" className="text-destructive text-sm">
          {m.messages_load_error()}
        </p>
        <Button variant="secondary" onClick={() => void thread.refetch()}>
          {m.common_try_again()}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-dvh flex-col md:min-h-0">
      <ThreadHeader
        displayName={displayName}
        handle={handle}
        image={other?.image ?? null}
        onHide={() =>
          hide.mutate(
            { conversationId },
            {
              onSuccess: () => {
                toast(m.messages_hidden());
                void navigate({ to: "/messages", replace: true });
              },
              onError: () => toast.error(m.messages_action_error()),
            },
          )
        }
        hidePending={hide.isPending}
      />
      <MessageScroll
        items={oldestFirst}
        hasNextPage={thread.hasNextPage}
        isFetching={thread.isFetchingNextPage}
        onLoadMore={() => void thread.fetchNextPage()}
        viewerId={viewerId ?? ""}
      />
      <Composer conversationId={conversationId} recipientId={other?.id ?? ""} />
    </div>
  );
}

function ThreadHeader({
  displayName,
  handle,
  image,
  onHide,
  hidePending,
  canHide = true,
}: {
  displayName: string;
  handle: string | null;
  image: string | null;
  onHide: () => void;
  hidePending: boolean;
  canHide?: boolean;
}) {
  return (
    <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/75 sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-3 backdrop-blur">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label={m.messages_back()}
        render={<Link to="/messages" />}
      >
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
      </Button>
      <Avatar className="h-9 w-9 shrink-0">
        {image && <AvatarImage src={image} alt="" />}
        <AvatarFallback>{displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
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
      </div>
      {canHide && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={m.messages_hide()}
          title={m.messages_hide()}
          disabled={hidePending}
          onClick={onHide}
        >
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </header>
  );
}

/**
 * The scroll surface: older pages load at the top, new messages arrive at
 * the bottom, and the pane pins to the newest message unless the reader has
 * scrolled up into history.
 */
function MessageScroll({
  items,
  hasNextPage,
  isFetching,
  onLoadMore,
  viewerId,
}: {
  items: ThreadItem[];
  hasNextPage: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
  viewerId: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previousCount = useRef(0);
  const locale = getLocale();

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Stay pinned to the newest message while the reader is at (or near) the
    // bottom; never yank them down while they read history above it.
    if (pinned.current) element.scrollTop = element.scrollHeight;
    previousCount.current = items.length;
  }, [items]);

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
      className="flex-1 space-y-1 overflow-y-auto px-4 py-4"
    >
      {hasNextPage && (
        <div className="flex justify-center pb-2">
          <Button variant="ghost" size="sm" disabled={isFetching} onClick={onLoadMore}>
            {isFetching ? m.messages_loading() : m.messages_load_older()}
          </Button>
        </div>
      )}
      {items.map((item) => {
        const mine = item.senderId === viewerId;
        return (
          <div key={item.id} className={`group flex ${mine ? "justify-end" : "justify-start"}`}>
            {item.deletedAt !== null ? (
              <p className="text-muted-foreground my-1 self-center text-xs italic">
                {m.messages_tombstone()}
              </p>
            ) : (
              <div
                className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  mine
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted text-foreground rounded-bl-sm"
                }`}
              >
                <LinkedText text={item.body ?? ""} />
                <span
                  className={`mt-0.5 block text-right text-[10px] ${
                    mine ? "text-primary-foreground/70" : "text-muted-foreground"
                  }`}
                >
                  {formatRelativeTime(item.createdAt, locale, m.post_just_now())}
                </span>
              </div>
            )}
            <div className="text-muted-foreground ml-1 hidden items-center self-center group-hover:flex">
              {mine && item.deletedAt === null && <DeleteOwnAction messageId={item.id} />}
              {!mine && item.deletedAt === null && (
                <ReportMessageAction messageId={item.id} body={item.body} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DeleteOwnAction({ messageId }: { messageId: string }) {
  const remove = useAtomValue(deleteMessageAtom);
  return (
    <button
      type="button"
      aria-label={m.messages_delete()}
      title={m.messages_delete()}
      disabled={remove.isPending}
      onClick={() =>
        remove.mutate(
          { messageId },
          {
            onError: () => {
              toast.error(m.messages_action_error());
              remove.reset();
            },
          },
        )
      }
      className="hover:text-destructive rounded p-1 transition-colors"
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

function ReportMessageAction({ messageId, body }: { messageId: string; body: string | null }) {
  const setReport = useSetAtom(reportDialogAtom);
  return (
    <button
      type="button"
      aria-label={m.moderation_report_title_message()}
      title={m.moderation_report_title_message()}
      onClick={() => setReport({ targetType: "message", targetId: messageId, body })}
      className="hover:text-destructive rounded p-1 transition-colors"
    >
      <Flag className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/** Enter sends, Shift+Enter breaks a line, and an IME composition never sends. */
function Composer({
  conversationId,
  recipientId,
}: {
  conversationId?: string;
  recipientId: string;
}) {
  const [draft, setDraft] = useState("");
  const send = useAtomValue(sendMessageAtom);
  const navigate = useNavigate();

  const submit = () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    setDraft("");
    send.mutate(
      { recipientId, body, conversationId },
      {
        onSuccess: (message) => {
          // First contact: the conversation id arrives with the message —
          // move to the real thread route so refresh and history work.
          if (!conversationId) {
            void navigate({
              to: "/messages/$conversationId",
              params: { conversationId: message.conversationId },
              replace: true,
            });
          }
        },
        onError: () => {
          setDraft(body);
          toast.error(m.messages_send_error());
          send.reset();
        },
      },
    );
  };

  return (
    <footer className="border-border bg-background sticky bottom-0 border-t p-3">
      <div className="border-border focus-within:border-primary/50 flex items-end gap-2 rounded-2xl border p-2">
        <textarea
          value={draft}
          rows={1}
          maxLength={MESSAGE_BODY_MAX_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // A composition session owns Enter (confirming the candidate);
            // sending under it would fire half-typed text.
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
          placeholder={m.messages_composer_placeholder()}
          aria-label={m.messages_composer_placeholder()}
          className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 text-sm outline-none"
        />
        <Button
          size="icon"
          className="rounded-full"
          aria-label={m.messages_send()}
          disabled={!draft.trim() || send.isPending}
          onClick={submit}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </footer>
  );
}

function ThreadSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-hidden>
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <Skeleton className="h-9 w-9 rounded-full motion-reduce:animate-none" />
        <Skeleton className="h-4 w-32 motion-reduce:animate-none" />
      </div>
      <div className="flex-1 space-y-3 p-4">
        <Skeleton className="h-10 w-1/2 rounded-2xl motion-reduce:animate-none" />
        <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl motion-reduce:animate-none" />
        <Skeleton className="h-10 w-3/5 rounded-2xl motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/**
 * The `/messages/new/$userId` pane: resolves an existing visible conversation
 * and moves to it, else offers the composer alone — the conversation is
 * created idempotently by the first send, never by a "start" step.
 */
export function NewMessagePane({ userId }: { userId: string }) {
  const lookup = useAtomValue(conversationWithFamily(userId));
  const navigate = useNavigate();

  useEffect(() => {
    if (lookup.data?.conversationId) {
      void navigate({
        to: "/messages/$conversationId",
        params: { conversationId: lookup.data.conversationId },
        replace: true,
      });
    }
  }, [lookup.data, navigate]);

  if (lookup.isPending) return <ThreadSkeleton />;
  if (lookup.isError || !lookup.data.user) {
    return (
      <div className="text-muted-foreground flex h-full min-h-64 flex-col items-center justify-center p-8">
        <p role="alert" className="text-destructive text-sm">
          {m.messages_new_not_found()}
        </p>
      </div>
    );
  }

  const user = lookup.data.user;
  const displayName = user.name || handleOf(user) || m.user_unknown();

  return (
    <div className="flex h-full min-h-dvh flex-col md:min-h-0">
      <ThreadHeader
        displayName={displayName}
        handle={handleOf(user)}
        image={user.image}
        onHide={() => {}}
        hidePending={false}
        canHide={false}
      />
      <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
        {m.messages_new_intro({ name: displayName })}
      </div>
      <Composer recipientId={userId} />
    </div>
  );
}
