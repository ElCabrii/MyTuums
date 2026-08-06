import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Loader2, ShieldAlert } from "lucide-react";
import { caseDialogAtom, moderationQueueAtom } from "@/atoms/moderation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CaseDialog } from "@/components/moderation/case-dialog";
import { reasonLabel } from "@/components/moderation/labels";
import { formatRelativeTime } from "@/lib/format";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import type { ModerationCase } from "@/lib/orpc";

/**
 * The moderation queue — one row per open case, newest report first, with an
 * open-appeal badge and the same four-state skeleton as `PostFeed`. A row
 * opens the shared case dialog (identity atom in `atoms/moderation.ts`), which
 * this view mounts because the queue is its only reader.
 */
export function QueueView() {
  const queue = useAtomValue(moderationQueueAtom);
  const openCase = useAtomValue(caseDialogAtom);
  const setOpenCase = useSetAtom(caseDialogAtom);

  if (queue.isPending) {
    return (
      <>
        {/* Mounted above the state branches: an action (e.g. Remove post)
            drains the queue while its case refetch lands, and the empty
            state must not unmount the dialog mid-flow — that is where the
            inverse (Restore) lives. */}
        {openCase && <CaseDialog target={openCase} onClose={() => setOpenCase(null)} />}
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none text-primary" />
        </div>
      </>
    );
  }

  if (queue.isError) {
    return (
      <>
        {openCase && <CaseDialog target={openCase} onClose={() => setOpenCase(null)} />}
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="space-y-2">
            <p>{queue.error.message || m.moderation_queue_error()}</p>
            <Button variant="outline" size="sm" onClick={() => void queue.refetch()}>
              {m.common_try_again()}
            </Button>
          </div>
        </div>
      </>
    );
  }

  const cases = queue.data.pages.flatMap((page) => page.items);

  if (cases.length === 0) {
    return (
      <>
        {openCase && <CaseDialog target={openCase} onClose={() => setOpenCase(null)} />}
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">{m.moderation_queue_empty()}</p>
        </div>
      </>
    );
  }

  return (
    <div className="space-y-4">
      {cases.map((item) => (
        <QueueRow key={`${item.targetType}|${item.targetId}`} item={item} />
      ))}

      {queue.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void queue.fetchNextPage()}
            disabled={queue.isFetchingNextPage}
            className="gap-2 rounded-full"
          >
            {queue.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{m.common_load_more()}</span>
          </Button>
        </div>
      )}

      {openCase && <CaseDialog target={openCase} onClose={() => setOpenCase(null)} />}
    </div>
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
