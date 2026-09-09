import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import { cancelPendingVideoAtom, pendingVideosAtom } from "@/atoms/pending-videos";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";

/** Pending rows have no permalink or public counters until publication commits. */
export function PendingVideos({ parentId }: { parentId?: string }) {
  const pending = useAtomValue(pendingVideosAtom);
  const cancel = useAtomValue(cancelPendingVideoAtom);
  const rows =
    pending.data?.filter((row) => parentId === undefined || row.parentId === parentId) ?? [];
  if (pending.isError)
    return (
      <div role="status" className="text-muted-foreground text-sm">
        {m.video_pending_unavailable()}
      </div>
    );
  if (rows.length === 0) return null;
  return (
    <section className="space-y-3" aria-label={m.video_pending_title()}>
      {rows.map((row) => (
        <article
          key={row.videoId}
          className="border-border bg-card space-y-2 rounded-xl border p-4"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {m.video_pending_title()}
          </p>
          <p className="text-muted-foreground text-xs">{m.video_pending_hint()}</p>
          {row.content && (
            <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">{row.content}</p>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate({ videoId: row.videoId })}
          >
            {m.video_pending_cancel()}
          </Button>
        </article>
      ))}
      {cancel.isError && (
        <p role="alert" className="text-destructive text-sm">
          {m.video_cancel_error()}
        </p>
      )}
    </section>
  );
}
