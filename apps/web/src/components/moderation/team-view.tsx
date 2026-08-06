import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Loader2, Users } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { roleLabel, roleRank } from "@/components/moderation/labels";
import { UserAvatar } from "@/components/user-avatar";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

/** Every role a grant can hand out, rank-ordered. */
const ALL_ROLES = ["user", "moderator", "staff", "admin"] as const;

/**
 * The moderation team — everyone with a role above `user`, with the Change
 * role affordance only where the viewer's rank permits managing that member.
 * Staff-only: the tab is hidden below staff, and `moderation.team` denies
 * below staff server-side regardless. The set-role dialog lives here because
 * this view is its only reader (same mount reasoning as `CaseDialog`).
 */
export function TeamView() {
  const team = useAtomValue(teamAtom);
  const viewer = useAtomValue(viewerAtom);
  const viewerRole = useAtomValue(viewerRoleAtom);
  const openTarget = useAtomValue(setRoleDialogAtom);
  const setOpenTarget = useSetAtom(setRoleDialogAtom);

  if (team.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none text-primary" />
      </div>
    );
  }

  if (team.isError) {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="space-y-2">
          <p>{team.error.message || m.moderation_team_error()}</p>
          <Button variant="outline" size="sm" onClick={() => void team.refetch()}>
            {m.common_try_again()}
          </Button>
        </div>
      </div>
    );
  }

  const members = team.data.items;

  if (members.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
        <Users className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{m.moderation_team_empty()}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {members.map((member) => {
        const memberHandle = handleOf(member);
        const canManage = member.id !== viewer?.id && roleRank(member.role ?? "user") < roleRank(viewerRole);
        return (
          <div key={member.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
            <UserAvatar user={member} alt={member.name || memberHandle || m.user_unknown()} className="h-9 w-9" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{member.name || memberHandle || m.user_unknown()}</p>
              {memberHandle && <p className="truncate text-xs text-muted-foreground">@{memberHandle}</p>}
            </div>
            <Badge variant={member.role === "admin" ? "destructive" : "outline"}>
              {roleLabel(member.role ?? "user")}
            </Badge>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() =>
                  setOpenTarget({ userId: member.id, handle: memberHandle ?? member.username ?? m.user_unknown() })
                }
              >
                {m.moderation_team_change_role()}
              </Button>
            )}
          </div>
        );
      })}

      {openTarget && <SetRoleDialog />}
    </div>
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
  const grantable: readonly string[] =
    viewerRole === "admin" ? ALL_ROLES : ["user", "moderator"];

  return (
    <Dialog open={target !== null} onOpenChange={(next) => { if (!next) setOpenTarget(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{m.moderation_set_role_title({ handle: target?.handle ?? "" })}</DialogTitle>
          <DialogDescription>{m.moderation_set_role_subtitle()}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-6">
          <Select value={role} onValueChange={(value) => setRolePick(value ?? "")}>
            <SelectTrigger className="w-full">
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
            <p role="alert" className="text-xs text-destructive">
              {setRole.error?.message ?? m.moderation_set_role_error()}
            </p>
          )}
          <Button
            className="w-full"
            disabled={!role || setRole.isPending}
            onClick={() => {
              if (!target) return;
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
