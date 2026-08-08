import { useAtomValue } from "jotai";
import { ClipboardList } from "lucide-react";
import { auditLogAtom } from "@/atoms/moderation";
import { PaginatedState } from "@/components/paginated-state";
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
 * below staff server-side regardless). The four-state skeleton is the shared
 * `PaginatedState`; the loaded state's rows live in a table, which is this
 * component's own content.
 */
export function AuditView() {
  const audit = useAtomValue(auditLogAtom);
  const entries = audit.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PaginatedState
      query={audit}
      errorMessage={m.moderation_audit_error()}
      emptyIcon={ClipboardList}
      emptyMessage={m.moderation_audit_empty()}
      isEmpty={entries.length === 0}
      listClassName="space-y-4"
    >
      <div className="border-border bg-card overflow-x-auto rounded-xl border">
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
    </PaginatedState>
  );
}

/** One audit row: the action, its reason/note, and the actor and target it involved. */
function AuditRow({ entry }: { entry: AuditEntry }) {
  const actorName = entry.actor
    ? entry.actor.name || handleOf(entry.actor) || m.user_unknown()
    : m.moderation_audit_none();
  const actorHandle = entry.actor ? handleOf(entry.actor) : null;
  const targetName = entry.targetUser
    ? entry.targetUser.name || handleOf(entry.targetUser) || m.user_unknown()
    : null;
  const targetHandle = entry.targetUser ? handleOf(entry.targetUser) : null;

  return (
    <TableRow>
      <TableCell className="align-top">
        <p className="font-medium">{actionLabel(entry.action)}</p>
        {(entry.reason || entry.note) && (
          <p className="text-muted-foreground mt-0.5 text-xs">{entry.reason ?? entry.note}</p>
        )}
      </TableCell>
      <TableCell className="align-top">
        {targetName ? (
          <p className="text-sm">
            {targetName}
            {targetHandle && (
              <span className="text-muted-foreground ml-1 text-xs">@{targetHandle}</span>
            )}
          </p>
        ) : entry.targetPostId ? (
          <p className="text-sm">
            {m.moderation_audit_post({ id: entry.targetPostId.slice(0, 8) })}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">{m.moderation_audit_none()}</p>
        )}
      </TableCell>
      <TableCell className="align-top">
        <p className="text-sm">
          {actorName}
          {actorHandle && (
            <span className="text-muted-foreground ml-1 text-xs">@{actorHandle}</span>
          )}
        </p>
      </TableCell>
      <TableCell className="text-muted-foreground align-top text-xs whitespace-nowrap">
        {formatRelativeTime(entry.createdAt, getLocale(), m.post_just_now())}
      </TableCell>
    </TableRow>
  );
}
