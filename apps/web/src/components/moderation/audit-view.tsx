import { useAtomValue } from "jotai";
import { ClipboardList } from "lucide-react";
import { auditLogAtom } from "@/atoms/moderation";
import { PaginatedState } from "@/components/paginated-state";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { actionBadgeVariant, actionIcon, actionLabel } from "@/components/moderation/labels";
import { UserAvatar } from "@/components/user-avatar";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
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
 *
 * A table, and only a table, at every width: `Table` scrolls horizontally
 * inside its own container, and a second card-shaped rendering for narrow
 * screens would put every actor and target name into the DOM twice — which is
 * exactly the kind of duplicate an accessible-name lookup then trips over.
 * What makes it fit instead is the column budget: the action reason wraps and
 * clamps, and the timestamp is the short relative form with the exact instant
 * on hover.
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
      loadingFallback={<AuditSkeleton />}
    >
      <Card size="sm" className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.moderation_audit_action()}</TableHead>
              <TableHead>{m.moderation_audit_target()}</TableHead>
              <TableHead>{m.moderation_audit_actor()}</TableHead>
              <TableHead className="text-right">{m.moderation_audit_when()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </TableBody>
        </Table>
      </Card>
    </PaginatedState>
  );
}

/** The shape of the table above, held while the first page loads. */
function AuditSkeleton() {
  return (
    <Card size="sm" className="gap-3">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex items-center gap-3 px-4">
          <Skeleton className="h-4 flex-1 motion-reduce:animate-none" />
          <Skeleton className="h-4 w-24 motion-reduce:animate-none" />
          <Skeleton className="h-4 w-24 motion-reduce:animate-none" />
          <Skeleton className="h-4 w-12 motion-reduce:animate-none" />
        </div>
      ))}
    </Card>
  );
}

/** One audit row: the action, its reason/note, and the actor and target it involved. */
function AuditRow({ entry }: { entry: AuditEntry }) {
  const locale = getLocale();

  return (
    <TableRow>
      <TableCell className="max-w-[16rem] align-top whitespace-normal">
        <Badge variant={actionBadgeVariant(entry.action)}>
          {actionIcon(entry.action)}
          {actionLabel(entry.action)}
        </Badge>
        {(entry.reason || entry.note) && (
          <p className="text-muted-foreground mt-1.5 line-clamp-2 text-xs">
            {entry.reason ?? entry.note}
          </p>
        )}
      </TableCell>
      <TableCell className="align-top">
        {entry.targetUser ? (
          <AuditPerson person={entry.targetUser} />
        ) : entry.targetPostId ? (
          <Badge variant="outline" className="font-mono">
            {m.moderation_audit_post({ id: entry.targetPostId.slice(0, 8) })}
          </Badge>
        ) : (
          <p className="text-muted-foreground text-xs">{m.moderation_audit_none()}</p>
        )}
      </TableCell>
      <TableCell className="align-top">
        {entry.actor ? (
          <AuditPerson person={entry.actor} />
        ) : (
          <p className="text-muted-foreground text-xs">{m.moderation_audit_none()}</p>
        )}
      </TableCell>
      <TableCell
        className="text-muted-foreground text-right align-top text-xs whitespace-nowrap"
        title={formatDateTime(entry.createdAt, locale)}
      >
        {formatRelativeTime(entry.createdAt, locale, m.post_just_now())}
      </TableCell>
    </TableRow>
  );
}

/**
 * An actor or a target cell: avatar, display name, handle. The avatar is what
 * makes a long log scannable — the same moderator's rows group visually
 * before a single name is read.
 */
function AuditPerson({ person }: { person: NonNullable<AuditEntry["actor"]> }) {
  const handle = handleOf(person);
  const displayName = person.name || handle || m.user_unknown();

  return (
    <div className="flex items-center gap-2">
      <UserAvatar user={person} alt={displayName} className="size-6" fallbackClassName="text-xs" />
      <div className="min-w-0">
        <p className="truncate text-sm">{displayName}</p>
        {handle && <p className="text-muted-foreground truncate text-xs">@{handle}</p>}
      </div>
    </div>
  );
}
