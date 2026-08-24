import type { MouseEventHandler, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ORPCError } from "@orpc/client";
import { profileAtomFamily } from "@/atoms/profile";
import { FollowButton } from "@/components/follow-button";
import { UserAvatar } from "@/components/user-avatar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import { Skeleton } from "@/components/ui/skeleton";

const PROFILE_HOVER_DELAY = 600;
const PROFILE_HOVER_CLOSE_DELAY = 300;
const BIO_SNIPPET_LENGTH = 120;

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
  const bio = profile.bio?.trim() || m.profile_hover_no_bio();
  const bioSnippet =
    bio.length > BIO_SNIPPET_LENGTH ? `${bio.slice(0, BIO_SNIPPET_LENGTH).trimEnd()}…` : bio;

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
          <Link
            to="/@{$username}"
            params={{ username: handle }}
            className="text-foreground block truncate font-bold hover:underline"
          >
            {displayName}
          </Link>
          <p className="text-muted-foreground truncate text-xs">@{handle}</p>
        </div>
      </div>

      <p className="text-foreground/90 text-sm leading-relaxed break-words whitespace-pre-line">
        {bioSnippet}
      </p>

      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">{followers}</span>
        <FollowButton
          userId={profile.id}
          isFollowing={profile.viewerIsFollowing}
          className="shrink-0"
        />
      </div>
    </div>
  );
}
