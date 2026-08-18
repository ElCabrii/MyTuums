import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { UserCog, Users } from "lucide-react";
import {
  resetRoleFormEffect,
  roleSelectAtom,
  setRoleAtom,
  setRoleDialogAtom,
  teamAtom,
} from "@/atoms/moderation";
import { viewerAtom, viewerRoleAtom } from "@/atoms/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PaginatedState } from "@/components/paginated-state";
import { roleIcon, roleLabel, roleRank } from "@/components/moderation/labels";
import { UserAvatar } from "@/components/user-avatar";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

/** Every role a grant can hand out, rank-ordered. */
const ALL_ROLES = ["user", "moderator", "staff", "admin"] as const;

/**
 * The grantable roles as a value → label map, for `SelectValue`: Base UI
 * renders the raw value ("moderator") unless the root is told what each one
 * is called.
 */
function roleItems(grantable: readonly string[]): Record<string, string> {
  return Object.fromEntries(grantable.map((candidate) => [candidate, roleLabel(candidate)]));
}

/**
 * The moderation team — everyone with a role above `user`, with the Change
 * role affordance only where the viewer's rank permits managing that member.
 * Staff-only: the tab is hidden below staff, and `moderation.team` denies
 * below staff server-side regardless. The set-role dialog lives here because
 * this view is its only reader (same mount reasoning as `CaseDialog`). The
 * four-state skeleton is the shared `PaginatedState` — with no pagination for
 * this endpoint, so no "Load more" ever renders.
 *
 * Rows are ordered by rank, highest first: the roster answers "who can do
 * what here", and the API returns it in no order the reader can see.
 */
export function TeamView() {
  const team = useAtomValue(teamAtom);
  const viewer = useAtomValue(viewerAtom);
  const viewerRole = useAtomValue(viewerRoleAtom);
  const openTarget = useAtomValue(setRoleDialogAtom);
  const members = [...(team.data?.items ?? [])].sort(
    (a, b) => roleRank(b.role ?? "user") - roleRank(a.role ?? "user"),
  );

  return (
    <PaginatedState
      query={team}
      errorMessage={m.moderation_team_error()}
      emptyIcon={Users}
      emptyMessage={m.moderation_team_empty()}
      isEmpty={members.length === 0}
      listClassName="space-y-3"
      loadingFallback={<TeamSkeleton />}
    >
      <p className="text-muted-foreground text-sm">
        {members.length === 1
          ? m.moderation_team_count_one({ count: "1" })
          : m.moderation_team_count_many({ count: String(members.length) })}
      </p>

      {members.map((member) => {
        const memberHandle = handleOf(member);
        const memberRole = member.role ?? "user";
        const isViewer = member.id === viewer?.id;
        const canManage = !isViewer && roleRank(memberRole) < roleRank(viewerRole);

        return (
          <Item key={member.id} variant="outline">
            <ItemMedia>
              <UserAvatar
                user={member}
                alt={member.name || memberHandle || m.user_unknown()}
                className="size-9"
              />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="flex-wrap">
                <span className="truncate">{member.name || memberHandle || m.user_unknown()}</span>
                {/* Beside the name rather than in the actions column: only
                    manageable members carry a button, so a role badge parked
                    against the right edge would sit at two different
                    positions down the same roster. */}
                <Badge variant={memberRole === "admin" ? "destructive" : "outline"}>
                  {roleIcon(memberRole)}
                  {roleLabel(memberRole)}
                </Badge>
                {isViewer && <Badge variant="secondary">{m.moderation_team_you()}</Badge>}
              </ItemTitle>
              {memberHandle && <ItemDescription>@{memberHandle}</ItemDescription>}
            </ItemContent>
            {canManage && (
              <ItemActions>
                <ChangeRoleButton member={member} handle={memberHandle} />
              </ItemActions>
            )}
          </Item>
        );
      })}

      {openTarget && <SetRoleDialog />}
    </PaginatedState>
  );
}

/** The shape of the roster, held while it loads. */
function TeamSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((row) => (
        <Item key={row} variant="outline">
          <ItemMedia>
            <Skeleton className="size-9 rounded-full" />
          </ItemMedia>
          <ItemContent className="gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </ItemContent>
          <ItemActions>
            <Skeleton className="h-5 w-16 rounded-full" />
          </ItemActions>
        </Item>
      ))}
    </div>
  );
}

/** Opens the set-role dialog for one member — the only writer of `setRoleDialogAtom`. */
function ChangeRoleButton({
  member,
  handle,
}: {
  member: { id: string; username?: string | null };
  handle: string | null;
}) {
  const setOpenTarget = useSetAtom(setRoleDialogAtom);

  return (
    <Button
      variant="outline"
      size="sm"
      className="rounded-full"
      onClick={() =>
        setOpenTarget({
          userId: member.id,
          handle: handle ?? member.username ?? m.user_unknown(),
        })
      }
    >
      <UserCog />
      {m.moderation_team_change_role()}
    </Button>
  );
}

/**
 * The change-role dialog — a single Select of every role the viewer is ranked
 * to grant, opening only from the team view. The pick resets per open via
 * `resetRoleFormEffect`.
 */
function SetRoleDialog() {
  useAtomValue(resetRoleFormEffect);
  const target = useAtomValue(setRoleDialogAtom);
  const setOpenTarget = useSetAtom(setRoleDialogAtom);
  const viewerRole = useAtomValue(viewerRoleAtom);
  const setRole = useAtomValue(setRoleAtom);
  const [role, setRolePick] = useAtom(roleSelectAtom);
  const grantable: readonly string[] = viewerRole === "admin" ? ALL_ROLES : ["user", "moderator"];

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) setOpenTarget(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{m.moderation_set_role_title({ handle: target?.handle ?? "" })}</DialogTitle>
          <DialogDescription>{m.moderation_set_role_subtitle()}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 pb-6">
          <Field>
            {/* A real `<label for>` rather than the `aria-label` this used to
                carry: the trigger's only text is the placeholder rendered
                inside the combobox, which is content, not a label — and a
                visible one also tells the reader what the picker is for. */}
            <FieldLabel htmlFor="set-role-select">{m.moderation_set_role_select()}</FieldLabel>
            <Select
              items={roleItems(grantable)}
              value={role}
              onValueChange={(value) => setRolePick(value ?? "")}
            >
              <SelectTrigger id="set-role-select" className="w-full">
                <SelectValue placeholder={m.moderation_set_role_select()} />
              </SelectTrigger>
              <SelectContent>
                {grantable.map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {roleLabel(candidate)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {setRole.isError && (
              <FieldError>{setRole.error?.message ?? m.moderation_set_role_error()}</FieldError>
            )}
          </Field>
          <Button
            className="w-full"
            disabled={!role || setRole.isPending}
            onClick={() => {
              if (!target) return;
              // SAFETY: the Select items are built off ALL_ROLES, so the value is
              // one of its literals by construction.
              setRole.mutate({ userId: target.userId, role: role as (typeof ALL_ROLES)[number] });
              setOpenTarget(null);
            }}
          >
            {m.moderation_set_role_submit()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
