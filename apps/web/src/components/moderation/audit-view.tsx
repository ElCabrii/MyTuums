import { useAtomValue } from "jotai";
import { AlertCircle, ClipboardList, Loader2 } from "lucide-react";
import { auditLogAtom } from "@/atoms/moderation";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { actionLabel } from "@/components/moderation/labels";
import { formatRelativeTime } from "@/lib/format";
import type { AuditEntry } from "@/lib/orpc";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

/**
 * The audit log — every moderation action, newest first, keyset-paginated.
 * Staff-only (the tab is hidden below staff, and `moderation.auditLog` denies
 * below staff server-side regardless).
 */
export function AuditView() {
  const audit = useAtomValue(auditLogAtom);

  if (audit.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none text-primary" />
      </div>
    );
  }

  if (audit.isError) {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="space-y-2">
          <p>{audit.error.message || m.moderation_audit_error()}</p>
          <Button variant="outline" size="sm" onClick={() => void audit.refetch()}>
            {m.common_try_again()}
          </Button>
        </div>
      </div>
    );
  }

  const entries = audit.data.pages.flatMap((page) => page.items);

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
        <ClipboardList className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{m.moderation_audit_empty()}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.moderation_audit_action()}</TableHead>
              <TableHead>{m.moderation_audit_target()}</TableHead>
              <TableHead>{m.moderation_audit_actor()}</TableHead>
              <TableHead>{m.moderation_audit_when()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </TableBody>
        </Table>
      </div>

      {audit.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void audit.fetchNextPage()}
            disabled={audit.isFetchingNextPage}
            className="gap-2 rounded-full"
          >
            {audit.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{m.common_load_more()}</span>
          </Button>
        </div>
      )}
    </div>
  );
}

/** One audit row: the action, its reason/note, and the actor and target it involved. */
function AuditRow({ entry }: { entry: AuditEntry }) {
  const actorName = entry.actor ? (entry.actor.name || handleOf(entry.actor)) || m.user_unknown() : m.moderation_audit_none();
  const actorHandle = entry.actor ? handleOf(entry.actor) : null;
  const targetName = entry.targetUser ? (entry.targetUser.name || handleOf(entry.targetUser)) || m.user_unknown() : null;
  const targetHandle = entry.targetUser ? handleOf(entry.targetUser) : null;

  return (
    <TableRow>
      <TableCell className="align-top">
        <p className="font-medium">{actionLabel(entry.action)}</p>
        {(entry.reason || entry.note) && (
          <p className="mt-0.5 text-xs text-muted-foreground">{entry.reason ?? entry.note}</p>
        )}
      </TableCell>
      <TableCell className="align-top">
        {targetName ? (
          <p className="text-sm">
            {targetName}
            {targetHandle && <span className="ml-1 text-xs text-muted-foreground">@{targetHandle}</span>}
          </p>
        ) : entry.targetPostId ? (
          <p className="text-sm">{m.moderation_audit_post({ id: entry.targetPostId.slice(0, 8) })}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{m.moderation_audit_none()}</p>
        )}
      </TableCell>
      <TableCell className="align-top">
        <p className="text-sm">
          {actorName}
          {actorHandle && <span className="ml-1 text-xs text-muted-foreground">@{actorHandle}</span>}
        </p>
      </TableCell>
      <TableCell className="align-top whitespace-nowrap text-xs text-muted-foreground">
        {formatRelativeTime(entry.createdAt, getLocale(), m.post_just_now())}
      </TableCell>
    </TableRow>
  );
}
