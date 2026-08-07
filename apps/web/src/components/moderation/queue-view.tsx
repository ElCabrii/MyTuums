import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ShieldAlert } from "lucide-react";
import { caseDialogAtom, moderationQueueAtom } from "@/atoms/moderation";
import { Badge } from "@/components/ui/badge";
import { CaseDialog } from "@/components/moderation/case-dialog";
import { PaginatedState } from "@/components/paginated-state";
import { reasonLabel } from "@/components/moderation/labels";
import { formatRelativeTime } from "@/lib/format";
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
      <PaginatedState
        query={queue}
        errorMessage={m.moderation_queue_error()}
        emptyIcon={ShieldAlert}
        emptyMessage={m.moderation_queue_empty()}
        isEmpty={cases.length === 0}
        listClassName="space-y-4"
      >
        {cases.map((item) => (
          <QueueRow key={`${item.targetType}|${item.targetId}`} item={item} />
        ))}
      </PaginatedState>
    </>
  );
}

/**
 * One case row: what the case is (post or user), how many open reports,
 * whether an appeal is pending, and the newest activity. Clicking opens the
 * case dialog — the whole row is a button, like a feed card.
 */
function QueueRow({ item }: { item: ModerationCase }) {
  const setOpenCase = useSetAtom(caseDialogAtom);
  const reasonSummary =
    item.reasons.map(reasonLabel).join(" · ") || item.appeal?.reason || "";

  return (
    <button
      type="button"
      onClick={() => setOpenCase({ targetType: item.targetType, targetId: item.targetId })}
      className="w-full cursor-pointer rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/30"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={item.targetType === "post" ? "secondary" : "outline"}>
          {item.targetType === "post" ? m.moderation_queue_target_post() : m.moderation_queue_target_user()}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {item.reportCount === 1
            ? m.moderation_case_reports_one({ count: "1" })
            : m.moderation_case_reports_many({ count: String(item.reportCount) })}
        </span>
        {item.appeal && <Badge variant="destructive">{m.moderation_queue_appeal()}</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">
          {formatRelativeTime(item.newestAt, getLocale(), m.post_just_now())}
        </span>
      </div>
      {reasonSummary && (
        <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{reasonSummary}</p>
      )}
    </button>
  );
}
