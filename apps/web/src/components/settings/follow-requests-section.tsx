import { useAtomValue } from "jotai";
import { Inbox } from "lucide-react";
import {
  acceptFollowRequestAtom,
  followRequestListAtom,
  rejectFollowRequestAtom,
} from "@/atoms/follow-requests";
import { Section } from "@/components/settings/section";
import { PaginatedState } from "@/components/paginated-state";
import { UserAvatar } from "@/components/user-avatar";
import { ProfileLink } from "@/components/profile-link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

/**
 * Three placeholder rows that mirror the follow-request row (avatar + name/handle
 * + Accept/Reject) while the inbox loads.
 *
 * `aria-hidden`: it paints structure, not information.
 */
function FollowRequestsSkeleton() {
  return (
    <div className="space-y-1" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 py-2">
          <Skeleton className="h-9 w-9 shrink-0 rounded-full motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-32 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
          </div>
          <div className="flex shrink-0 gap-2">
            <Skeleton className="h-9 w-16 shrink-0 rounded-md motion-reduce:animate-none" />
            <Skeleton className="h-9 w-16 shrink-0 rounded-md motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Inbound follow requests (issue #328) — the target-side inbox for a private
 * account. Lists requesters newest-first with Accept/Reject. Rare enough that
 * every write invalidates (see `atoms/follow-requests.ts`) rather than
 * patching optimistically.
 */
export function FollowRequestsSection() {
  const requests = useAtomValue(followRequestListAtom);
  const accept = useAtomValue(acceptFollowRequestAtom);
  const reject = useAtomValue(rejectFollowRequestAtom);

  const people = requests.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Section
      title={m.settings_privacy_requests_title()}
      description={m.settings_privacy_requests_description()}
      icon={<Inbox className="h-5 w-5" />}
    >
      <PaginatedState
        query={requests}
        emptyMessage={m.settings_privacy_requests_empty()}
        errorMessage={m.settings_privacy_requests_error()}
        emptyIcon={Inbox}
        isEmpty={people.length === 0}
        loadingFallback={<FollowRequestsSkeleton />}
      >
        {people.map((user) => {
          const handle = handleOf(user);
          const displayName = user.name || handle || "";
          return (
            <div key={user.id} className="flex items-center gap-3 py-2">
              <UserAvatar user={user} alt={displayName} className="h-9 w-9" />
              <div className="min-w-0 flex-1">
                {handle ? (
                  <ProfileLink username={handle} className="block min-w-0 hover:underline">
                    <span className="text-foreground block truncate text-sm font-bold">
                      {displayName}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">@{handle}</span>
                  </ProfileLink>
                ) : (
                  <span className="text-foreground block truncate text-sm font-bold">
                    {displayName}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => accept.mutate({ requesterId: user.id })}
                  disabled={accept.isPending || reject.isPending}
                >
                  {m.settings_privacy_accept()}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => reject.mutate({ requesterId: user.id })}
                  disabled={accept.isPending || reject.isPending}
                >
                  {m.settings_privacy_reject()}
                </Button>
              </div>
            </div>
          );
        })}
      </PaginatedState>
    </Section>
  );
}
