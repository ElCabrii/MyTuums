import type { MouseEventHandler, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ORPCError } from "@orpc/client";
import { profileAtomFamily } from "@/atoms/profile";
import { FollowButton } from "@/components/follow-button";
// Mutual import: LinkedText renders @mentions as ProfileLink (with their own
// hover preview), and ProfileLink's hover card renders LinkedText for the bio.
// The cycle is inherent to the domain — profiles mention profiles — and
// runtime-safe: Base UI renders hover-card content lazily on hover, so the
// reference never unfolds eagerly (a self-referential bio yields one mention
// link, not an infinite tree). Left static on purpose: mentions keep their
// hover preview by design, and both modules export hoisted functions with no
// top-level cross-references, so the cycle is initialization-safe.
import { LinkedText } from "@/components/linked-text";
import { ProfileBadges } from "@/components/profile-badges";
import { UserAvatar } from "@/components/user-avatar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import { Skeleton } from "@/components/ui/skeleton";

const PROFILE_HOVER_DELAY = 600;
const PROFILE_HOVER_CLOSE_DELAY = 300;

interface ProfileLinkProps {
  username: string;
  children: ReactNode;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  "aria-label"?: string;
  title?: string;
}

/**
 * A normal profile link with the shared profile preview attached to it.
 *
 * The trigger is composed onto TanStack Router's actual `<a>` rather than
 * wrapping it in another element. That keeps middle-click, open-in-new-tab,
 * touch navigation and the router's own click handling intact while Base UI
 * adds hover/focus and Escape dismissal behavior.
 */
export function ProfileLink({
  username,
  children,
  className,
  onClick,
  "aria-label": ariaLabel,
  title,
}: ProfileLinkProps) {
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={PROFILE_HOVER_DELAY}
        closeDelay={PROFILE_HOVER_CLOSE_DELAY}
        render={
          <Link
            to="/@{$username}"
            params={{ username }}
            className={className}
            onClick={onClick}
            aria-label={ariaLabel}
            title={title}
          >
            {children}
          </Link>
        }
      />
      <HoverCardContent>
        <ProfileHoverCardContent username={username} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** The profile data view rendered inside a trigger's portal. */
function ProfileHoverCardContent({ username }: { username: string }) {
  const profileQuery = useAtomValue(profileAtomFamily(username));

  if (profileQuery.isPending) {
    return (
      <div className="space-y-3" aria-label={m.profile_hover_loading()}>
        <div className="flex items-center gap-3">
          <Skeleton className="size-12 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-8 w-24" />
      </div>
    );
  }

  if (profileQuery.isError || !profileQuery.data) {
    const isNotFound =
      profileQuery.error instanceof ORPCError && profileQuery.error.code === "NOT_FOUND";

    return (
      <p className="text-muted-foreground text-sm" role="status">
        {isNotFound ? m.profile_not_found() : m.profile_hover_error()}
      </p>
    );
  }

  const profile = profileQuery.data;
  if (profile.suspended) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        {m.profile_suspended_body()}
      </p>
    );
  }

  const handle = handleOf(profile) ?? username;
  const displayName = profile.name || handle;
  const followerCount = new Intl.NumberFormat(getLocale()).format(profile.followerCount);
  const followers =
    profile.followerCount === 1
      ? m.profile_hover_follower_one({ count: followerCount })
      : m.profile_hover_follower_many({ count: followerCount });
  // Omit the bio line entirely when there is none: the card already shows the
  // name, handle, avatar, follower count and follow button, so a "no bio"
  // placeholder adds no information (issue #216).
  const bio = profile.bio?.trim();

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Link
          to="/@{$username}"
          params={{ username: handle }}
          aria-label={m.user_view_profile({ name: displayName })}
          className="focus-visible:ring-ring shrink-0 rounded-full outline-none focus-visible:ring-2"
        >
          <UserAvatar
            user={profile}
            alt={displayName}
            className="size-12"
            fallbackClassName="bg-primary text-primary-foreground text-sm"
          />
        </Link>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Link
              to="/@{$username}"
              params={{ username: handle }}
              className="text-foreground block truncate font-bold hover:underline"
            >
              {displayName}
            </Link>
            {/* The same badge row the profile header renders (issue #308), at
                the card's smaller scale. */}
            <ProfileBadges badges={profile.badges} />
          </div>
          <p className="text-muted-foreground truncate text-xs">@{handle}</p>
        </div>
      </div>

      {/* The bio gets the same LinkedText rendering as every other bio
          surface, clamped visually instead of string-sliced so truncation can
          never cut a URL or mention mid-token into a dead partial link. A
          mention here intentionally opens its own hover preview inside this
          card, as it already does inside the moderation case dialog. */}
      {bio && (
        <p className="text-foreground/90 line-clamp-3 text-sm leading-relaxed break-words whitespace-pre-line">
          <LinkedText text={bio} />
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">{followers}</span>
        <FollowButton
          userId={profile.id}
          isFollowing={profile.viewerIsFollowing}
          hasRequested={profile.hasRequested}
          className="shrink-0"
        />
      </div>
    </div>
  );
}
