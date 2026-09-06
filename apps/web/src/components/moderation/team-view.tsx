import { useEffect, useRef } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Search, SearchX, UserCog, Users, X } from "lucide-react";
import {
  debouncedTeamSearchAtom,
  resetRoleFormEffect,
  resetTeamSearchAtom,
  roleSelectAtom,
  setRoleAtom,
  setRoleDialogAtom,
  setTeamSearchAtom,
  teamAtom,
  teamSearchAtom,
  teamSearchInputAtom,
} from "@/atoms/moderation";
import { viewerIdAtom, viewerRoleAtom } from "@/atoms/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { roleIcon, roleLabel } from "@/components/moderation/labels";
import { canManageRole, roleRank } from "@my-tuums/api/roles";
import { UserAvatar } from "@/components/user-avatar";
import { ProfileLink } from "@/components/profile-link";
import type { TeamMember } from "@/lib/orpc";
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
 * The Team tab: the moderation roster, and the account lookup that reaches
 * everyone who is not on it yet.
 *
 * The lookup exists because the roster answers only "who holds a role" —
 * before it, a plain `user` had no surface to be promoted from at all, and
 * the only path into the hierarchy was the `db:promote` script (issue #145).
 * Its results replace the roster while a query is typed rather than sitting
 * beside it: both lists render the same rows, and two lists that can show the
 * same person twice read as a bug.
 *
 * Staff-only: the tab is hidden below staff, and `moderation.team` /
 * `moderation.searchUsers` deny below staff server-side regardless. The
 * set-role dialog lives here because this view is its only reader (same mount
 * reasoning as `CaseDialog`).
 */
export function TeamView() {
  const query = useAtomValue(teamSearchInputAtom);
  const openTarget = useAtomValue(setRoleDialogAtom);
  const resetSearch = useSetAtom(resetTeamSearchAtom);

  // The lookup atoms are module-scoped and outlive this tab, so without a
  // reset the next mount would open on the previous query's results (the same
  // unmount-reset the SearchBox does with `resetSearchAtomsAtom`).
  useEffect(() => resetSearch, [resetSearch]);

  return (
    <div className="space-y-4">
      <AccountLookup />
      {query.trim() === "" ? <TeamRoster /> : <LookupResults />}
      {openTarget && <SetRoleDialog />}
    </div>
  );
}

/**
 * The lookup field — a plain search input, not the header's combobox: the
 * results render inline underneath, so there is no popup to position and no
 * highlight for the keyboard to move through.
 */
function AccountLookup() {
  const value = useAtomValue(teamSearchInputAtom);
  const setQuery = useSetAtom(setTeamSearchAtom);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Field>
      <FieldLabel htmlFor="team-account-search">{m.moderation_team_search_label()}</FieldLabel>
      <div className="relative">
        <Search className="text-muted-foreground absolute top-2.5 left-2.5 h-4 w-4" />
        <Input
          ref={inputRef}
          id="team-account-search"
          type="search"
          className="w-full pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
          placeholder={m.moderation_team_search_placeholder()}
          value={value}
          onChange={(event) => setQuery(event.target.value)}
        />
        {value !== "" && (
          <button
            type="button"
            aria-label={m.search_clear()}
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="text-muted-foreground hover:bg-muted/60 hover:text-foreground absolute top-1/2 right-2 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full transition-colors"
          >
            <X className="pointer-events-none h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <FieldDescription>{m.moderation_team_search_hint()}</FieldDescription>
    </Field>
  );
}

/**
 * Everyone with a role above `user`, ordered by rank, highest first: the
 * roster answers "who can do what here", and the API returns it in no order
 * the reader can see. The four-state skeleton is the shared `PaginatedState`
 * — with no pagination for this endpoint, so no "Load more" ever renders.
 */
function TeamRoster() {
  const team = useAtomValue(teamAtom);
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

      {members.map((member) => (
        <MemberRow key={member.id} member={member} />
      ))}
    </PaginatedState>
  );
}

/**
 * The accounts matching the lookup, whatever role they hold — the same rows
 * as the roster, so a candidate reads exactly like the member they are about
 * to become. While the immediate input is ahead of the debounced query, the
 * prior query's rows are hidden so their actions cannot be mistaken for
 * matches to the new input.
 */
function LookupResults() {
  const query = useAtomValue(teamSearchInputAtom).trim();
  const debouncedQuery = useAtomValue(debouncedTeamSearchAtom);
  const results = useAtomValue(teamSearchAtom);
  const items = results.data?.items ?? [];

  if (query !== debouncedQuery) return <TeamSkeleton />;

  return (
    <PaginatedState
      query={results}
      errorMessage={m.moderation_team_search_error()}
      emptyIcon={SearchX}
      emptyMessage={m.moderation_team_search_empty({ query })}
      isEmpty={items.length === 0}
      listClassName="space-y-3"
      loadingFallback={<TeamSkeleton />}
    >
      {items.map((member) => (
        <MemberRow key={member.id} member={member} />
      ))}
    </PaginatedState>
  );
}

/**
 * One account, in the roster or in the lookup results: who they are, the role
 * they hold, and the Change role affordance where the viewer's rank permits
 * managing them.
 */
function MemberRow({ member }: { member: TeamMember }) {
  const viewerId = useAtomValue(viewerIdAtom);
  const viewerRole = useAtomValue(viewerRoleAtom);
  const memberHandle = handleOf(member);
  const displayName = member.name || memberHandle || m.user_unknown();
  const memberRole = member.role ?? "user";
  const isViewer = member.id === viewerId;
  // `canManageRole` is strictly-greater, so it already refuses the viewer's
  // own row — the viewer always holds their own rank.
  const canManage = canManageRole(viewerRole, memberRole);

  return (
    <Item variant="outline">
      <ItemMedia>
        {memberHandle ? (
          <ProfileLink
            username={memberHandle}
            aria-label={displayName}
            className="focus-visible:ring-ring/50 rounded-full outline-none hover:opacity-80 focus-visible:ring-[3px]"
          >
            <UserAvatar user={member} alt={displayName} className="size-9" />
          </ProfileLink>
        ) : (
          <UserAvatar user={member} alt={displayName} className="size-9" />
        )}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {memberHandle ? (
            <ProfileLink
              username={memberHandle}
              className="focus-visible:ring-ring/50 min-w-0 truncate rounded-sm outline-none hover:underline focus-visible:ring-[3px]"
            >
              {displayName}
            </ProfileLink>
          ) : (
            <span className="truncate">{displayName}</span>
          )}
          {/* Beside the name rather than in the actions column: only
              manageable members carry a button, so a role badge parked
              against the right edge would sit at two different positions
              down the same roster. */}
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
}

/** The shape of the roster, held while it loads. */
function TeamSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((row) => (
        <Item key={row} variant="outline">
          <ItemMedia>
            <Skeleton className="size-9 rounded-full motion-reduce:animate-none" />
          </ItemMedia>
          <ItemContent className="gap-2">
            <Skeleton className="h-4 w-32 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-20 motion-reduce:animate-none" />
          </ItemContent>
          <ItemActions>
            <Skeleton className="h-5 w-16 rounded-full motion-reduce:animate-none" />
          </ItemActions>
        </Item>
      ))}
    </div>
  );
}

/** Opens the set-role dialog for one account — the only writer of `setRoleDialogAtom`. */
function ChangeRoleButton({
  member,
  handle,
}: {
  member: { id: string; username?: string | null; role?: string | null };
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
          currentRole: member.role ?? "user",
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
 * to grant, opening from either list in the Team tab. The pick resets per
 * open via `resetRoleFormEffect`.
 */
function SetRoleDialog() {
  useAtomValue(resetRoleFormEffect);
  const target = useAtomValue(setRoleDialogAtom);
  const setOpenTarget = useSetAtom(setRoleDialogAtom);
  const viewerRole = useAtomValue(viewerRoleAtom);
  const setRole = useAtomValue(setRoleAtom);
  const [role, setRolePick] = useAtom(roleSelectAtom);
  const grantable = (viewerRole === "admin" ? ALL_ROLES : ["user", "moderator"]).filter(
    (candidate) => candidate !== target?.currentRole,
  );

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
