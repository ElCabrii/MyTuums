import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ChevronRight,
  FileText,
  Gavel,
  Inbox,
  RefreshCw,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import {
  caseDialogAtom,
  moderationQueueAtom,
  moderationQueueSummaryAtom,
} from "@/atoms/moderation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { CaseDialog } from "@/components/moderation/case-dialog";
import { PaginatedState } from "@/components/paginated-state";
import { PostAttachmentGrid } from "@/components/post-attachment-grid";
import { reasonBadgeVariant, reasonLabel } from "@/components/moderation/labels";
import { UserAvatar } from "@/components/user-avatar";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import type { ModerationCase } from "@/lib/orpc";

/**
 * The moderation queue — one row per open case, newest report first, with an
 * open-appeal badge and the same four-state skeleton as `PostFeed` (shared via
 * `PaginatedState`). A row opens the shared case dialog (identity atom in
 * `atoms/moderation.ts`), which this view mounts because the queue is its only
 * reader — once, above the state branches, so an action that drains the queue
 * while its case refetch lands never unmounts the dialog mid-flow (that is
 * where the inverse — Restore — lives).
 *
 * The counters above the list are what a triaging moderator asks first ("how
 * much is waiting, and how much of it is an appeal someone is waiting on"),
 * and Refresh is here because the queue is a shared worklist: a colleague
 * draining a case is invisible until this refetches.
 */
export function QueueView() {
  const queue = useAtomValue(moderationQueueAtom);
  // One `useAtom` instead of `useAtomValue` + `useSetAtom` — the dialog
  // identity is read and written in the same component, so the pair of
  // hooks collapses into a single subscription (issue #59).
  const [openCase, setOpenCase] = useAtom(caseDialogAtom);
  const cases = queue.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      {/* Mounted once, above the state branches — see the component comment.
          Keyed per case, the same defence `AppealPage` uses: the dialog's
          mutation atoms are module-scoped singletons, so a failed action on
          one case must not greet the next case's dialog (issue #59). */}
      {openCase && (
        <CaseDialog
          key={`${openCase.targetType}|${openCase.targetId}`}
          target={openCase}
          onClose={() => setOpenCase(null)}
        />
      )}
      <div className="space-y-4">
        <QueueSummaryBar />
        <PaginatedState
          query={queue}
          errorMessage={m.moderation_queue_error()}
          emptyIcon={ShieldAlert}
          emptyMessage={m.moderation_queue_empty()}
          isEmpty={cases.length === 0}
          listClassName="space-y-3"
          loadingFallback={<QueueSkeleton />}
        >
          {cases.map((item) => (
            <QueueRow key={`${item.targetType}|${item.targetId}`} item={item} />
          ))}
        </PaginatedState>
      </div>
    </>
  );
}

/**
 * How much is waiting, and the manual refetch beside it. Reads the derived
 * summary rather than the page list so the counting rule lives in one place
 * (`moderationQueueSummaryAtom`); `isFetching` rather than `isRefetching`
 * covers the "Load more" fetch too, which is the other thing that makes the
 * counts move.
 */
function QueueSummaryBar() {
  const queue = useAtomValue(moderationQueueAtom);
  const summary = useAtomValue(moderationQueueSummaryAtom);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">
        <Inbox />
        {/* "+" while a cursor is outstanding: these are the cases fetched so
            far, and claiming a total the server never sent would be a lie the
            next "Load more" exposes. */}
        {summary.loaded === 1 && !summary.hasMore
          ? m.moderation_queue_open_one({ count: "1" })
          : m.moderation_queue_open_many({
              count: `${String(summary.loaded)}${summary.hasMore ? "+" : ""}`,
            })}
      </Badge>
      {summary.appeals > 0 && (
        <Badge variant="destructive">
          <Gavel />
          {summary.appeals === 1
            ? m.moderation_queue_appeals_one({ count: "1" })
            : m.moderation_queue_appeals_many({ count: String(summary.appeals) })}
        </Badge>
      )}
      {/* Deliberately not disabled while fetching: React Query de-dupes a
          refetch that is already in flight, so the only thing disabling would
          add is a greyed-out control failing contrast at the exact moment the
          spinner says something is happening. */}
      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void queue.refetch()}>
        <RefreshCw className={queue.isFetching ? "animate-spin motion-reduce:animate-none" : ""} />
        {m.moderation_queue_refresh()}
      </Button>
    </div>
  );
}

/** The shape of the rows below, held while the first page loads. */
function QueueSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((row) => (
        <Item key={row} variant="outline">
          <ItemMedia variant="icon" className="bg-muted size-9 rounded-full">
            <Skeleton className="size-4 rounded-full" />
          </ItemMedia>
          <ItemContent className="gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </ItemContent>
        </Item>
      ))}
    </div>
  );
}

/** The target preview a queue row renders, or `null` when the target row is gone. */
type CasePreview = ModerationCase["preview"];

/** Whoever a case is about: the reported post's author, or the reported account. */
function personOf(preview: CasePreview) {
  if (preview === null) return null;
  return preview.kind === "post" ? preview.author : preview.user;
}

/**
 * One case row: who and what the case is about, how many open reports, why it
 * was reported, whether an appeal is pending, and the newest activity.
 * Clicking opens the case dialog — the whole row is a button, like a feed
 * card, so the row's rendered text is also its accessible name.
 *
 * The reasons render as their own badges rather than a joined sentence, and
 * the severe ones (`reasonBadgeVariant`) read destructive: this list is
 * scanned, not read, and severity is the only thing in it that decides order
 * of work.
 *
 * The second line is the target preview `moderation.queue` now returns. It is
 * what makes the list triageable at all: a row of counts and reason codes
 * says how much is waiting but nothing about which case to open first, so the
 * only way to find the one that matters was to open every one of them.
 */
function QueueRow({ item }: { item: ModerationCase }) {
  const setOpenCase = useSetAtom(caseDialogAtom);
  const isPost = item.targetType === "post";
  const locale = getLocale();
  const preview = item.preview;
  const person = personOf(preview);
  const handle = handleOf(person);

  return (
    <Item
      variant="outline"
      className="hover:border-primary/30 hover:bg-muted/40 w-full cursor-pointer text-left transition-colors"
      render={
        <button
          type="button"
          onClick={() => setOpenCase({ targetType: item.targetType, targetId: item.targetId })}
        />
      }
    >
      <ItemMedia>
        {person ? (
          <UserAvatar
            user={person}
            alt={person.name || handle || m.user_unknown()}
            className="size-9"
          />
        ) : (
          // No preview means the target row is gone, so there is no face to
          // put here — the generic glyph at least keeps the row's shape.
          <span className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-full">
            {isPost ? <FileText className="size-4" /> : <UserRound className="size-4" />}
          </span>
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex-wrap">
          <span>
            {isPost ? m.moderation_queue_target_post() : m.moderation_queue_target_user()}
          </span>
          <span className="text-muted-foreground text-xs font-normal">
            {item.reportCount === 1
              ? m.moderation_case_reports_one({ count: "1" })
              : m.moderation_case_reports_many({ count: String(item.reportCount) })}
          </span>
          {item.appeals.length > 0 && (
            <Badge variant="destructive">
              <Gavel />
              {m.moderation_queue_appeal()}
            </Badge>
          )}
          {/* The target's own state, in outline so it never outranks a reason
              badge: it says what has already happened to this target, which
              is context for the decision rather than a reason to make one. */}
          <TargetStateBadges preview={preview} />
          {/* Inline rather than on their own row: at this width the reasons
              are what the eye lands on, and pushing them below the title
              doubled every row's height for one line of chips. They wrap
              under the title by themselves once the row runs out of room. */}
          {item.reasons.map((reason) => (
            <Badge key={reason} variant={reasonBadgeVariant(reason)}>
              {reasonLabel(reason)}
            </Badge>
          ))}
        </ItemTitle>
        <TargetLine preview={preview} />
        {/* The post's attachments, as compact thumbnails: for an image-only
            report the image is the whole substance of the case, and the row
            is the one place a moderator triages without opening it. The grid is
            link-less in compact mode so a click still opens the case (the row
            is a `<button>`); the case dialog renders the full, link-wrapped
            set. */}
        {preview?.kind === "post" && (
          <PostAttachmentGrid attachments={preview.attachments} compact />
        )}
        {/* One line per open appeal: a target can carry appeals from two
            control families at once (a ban and a role change), and showing
            only the newest hid the other from triage entirely. */}
        {item.appeals.map((appeal) => (
          <ItemDescription key={appeal.id} className="text-xs italic">
            {appeal.reason}
          </ItemDescription>
        ))}
      </ItemContent>
      {/* `self-start`: the content column is one to four lines depending on
          the excerpt and the appeal, and a vertically centred timestamp
          drifts away from the title it dates. */}
      <ItemActions className="self-start">
        <span
          className="text-muted-foreground text-xs whitespace-nowrap"
          title={formatDateTime(item.newestAt, locale)}
        >
          {formatRelativeTime(item.newestAt, locale, m.post_just_now())}
        </span>
        <ChevronRight className="text-muted-foreground size-4" />
      </ItemActions>
    </Item>
  );
}

/**
 * What has already been done to the target: a removed post, a reply, an
 * account currently serving a suspension or a permanent ban.
 *
 * `banExpires` is what separates the last two — the server sends the
 * *effective* ban (an expired sentence reads as clear), and a timed one still
 * carries its end date.
 */
function TargetStateBadges({ preview }: { preview: CasePreview }) {
  if (preview === null) return null;

  if (preview.kind === "post") {
    return (
      <>
        {preview.isReply && <Badge variant="outline">{m.moderation_case_reply_badge()}</Badge>}
        {preview.removed && <Badge variant="outline">{m.moderation_case_removed_badge()}</Badge>}
      </>
    );
  }

  if (!preview.banned) return null;
  return (
    <Badge variant="outline">
      {preview.banExpires ? m.moderation_queue_suspended_badge() : m.moderation_case_banned_badge()}
    </Badge>
  );
}

/**
 * The row's second line: who the case is about, and — for a post — the
 * server-bounded excerpt of what they wrote. The name carries the foreground
 * colour so the eye separates the person from their words inside one line.
 */
function TargetLine({ preview }: { preview: CasePreview }) {
  const person = personOf(preview);
  if (preview === null || person === null) {
    return <ItemDescription>{m.moderation_queue_target_gone()}</ItemDescription>;
  }

  const handle = handleOf(person);
  return (
    <ItemDescription>
      <span className="text-foreground font-medium">
        {person.name || handle || m.user_unknown()}
      </span>
      {handle && <span> @{handle}</span>}
      {preview.kind === "post" && preview.excerpt && (
        <>
          {" — "}
          {preview.excerpt}
          {preview.truncated && "\u2026"}
        </>
      )}
    </ItemDescription>
  );
}
