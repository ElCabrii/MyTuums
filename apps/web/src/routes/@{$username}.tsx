import { createFileRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ORPCError } from "@orpc/client";
import { authClient, useSession } from "@/lib/auth-client";
import { formatCount, formatJoinDate } from "@/lib/format";
import { orpc, retryUnlessClientError } from "@/lib/orpc";
import { handleOf, initialsOf } from "@/lib/user";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FollowButton } from "@/components/follow-button";
import { ProfileMessage } from "@/components/profile-message";
import { SegmentedNav, SegmentedNavItem } from "@/components/segmented-nav";
import { UserX, Mail, Calendar, LogOut, Loader2, AlertCircle, Settings } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/@{$username}")({
  component: ProfileLayout,
});

/**
 * The persistent half of a profile: banner, avatar, name, follow state and the
 * section tabs. The Posts / Followers / Following bodies are the nested routes
 * rendered through `<Outlet />`, so switching between them doesn't remount
 * this header or refetch the profile.
 *
 * Exported for ./profile.test.tsx: reaching it through `Route.component`
 * instead would mean typing against the router's internals.
 */
export function ProfileLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { username } = Route.useParams();
  const { pathname } = useLocation();
  const { data: session } = useSession();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const profileQuery = useQuery({
    ...orpc.user.byUsername.queryOptions({ input: { username } }),
    retry: retryUnlessClientError,
  });

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      // Cached profiles and feeds carry viewer-dependent fields
      // (`viewerIsFollowing`, `viewerHasLiked`) but their query keys contain
      // no viewer identity, so without this the next visitor on this browser
      // sees the previous session's follow state until each query refetches.
      queryClient.clear();
      void navigate({ to: "/login" });
    } catch (err) {
      console.error("Failed to sign out", err);
    } finally {
      setIsSigningOut(false);
    }
  };

  if (profileQuery.isPending) {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (profileQuery.isError) {
    const notFound =
      profileQuery.error instanceof ORPCError && profileQuery.error.code === "NOT_FOUND";

    return notFound ? (
      <ProfileMessage icon={UserX} title={`@${username}`}>
        <p className="text-muted-foreground text-sm mb-6">
          There's nobody here. This handle isn't taken.
        </p>
        <Button nativeButton={false} render={<Link to="/" className="w-full justify-center" />}>
          Back to home
        </Button>
      </ProfileMessage>
    ) : (
      <ProfileMessage icon={AlertCircle} title="Couldn't load this profile">
        <p className="text-muted-foreground text-sm mb-6">
          {profileQuery.error.message || "Something went wrong."}
        </p>
        <Button variant="outline" onClick={() => void profileQuery.refetch()} className="w-full">
          Try again
        </Button>
      </ProfileMessage>
    );
  }

  const profile = profileQuery.data;
  const isOwnProfile = session?.user.id === profile.id;
  const handle = profile.displayUsername || handleOf(profile) || username;
  const displayName = profile.name || handle;
  const initials = initialsOf(displayName);

  // `handle` above is display-oriented and may be mixed-case. Route params
  // must use the normalised handle, the same one post-card.tsx links with, so
  // every link to this profile lands on one `byUsername` cache entry rather
  // than fragmenting it across casings.
  const linkHandle = handleOf(profile) ?? username;

  // Which tab is selected is a property of the URL, not of local state, so it
  // survives a reload and a shared link. Derived from the path suffix rather
  // than `Link`'s own `activeProps`, because what changes here is the Button
  // *variant* — a prop, not a class the router can merge in.
  const section = pathname.endsWith("/followers")
    ? "followers"
    : pathname.endsWith("/following")
      ? "following"
      : "posts";

  return (
    <div className="min-h-screen bg-background pb-12">
      {/* Banner */}
      <div className="w-full h-48 sm:h-64 relative bg-muted border-b border-border overflow-hidden" />

      <div className="max-w-[1500px] mx-auto px-4 sm:px-8">
        {/* Avatar & Action buttons */}
        <div className="relative flex justify-between items-end -mt-16 sm:-mt-20 mb-4">
          <Avatar className="h-28 w-28 sm:h-36 sm:w-36 border-4 border-background shadow-xl ring-2 ring-primary/20 bg-background">
            <AvatarImage src={profile.image || undefined} alt={displayName} />
            <AvatarFallback className="text-2xl sm:text-3xl font-bold bg-primary text-primary-foreground">
              {initials}
            </AvatarFallback>
          </Avatar>

          {isOwnProfile ? (
            <div className="flex gap-2.5 mb-2">
              <Button variant="outline" size="sm" className="gap-2 rounded-full border-muted-foreground/30">
                <Settings className="h-4 w-4" />
                <span>Edit Profile</span>
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleSignOut()}
                disabled={isSigningOut}
                className="gap-2 rounded-full"
              >
                {isSigningOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                <span>Sign out</span>
              </Button>
            </div>
          ) : (
            <div className="mb-2">
              <FollowButton userId={profile.id} isFollowing={profile.viewerIsFollowing} />
            </div>
          )}
        </div>

        {/* Profile Info */}
        <div className="space-y-3 mb-6">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{displayName}</h1>
            </div>
            <p className="text-muted-foreground text-sm font-medium">@{handle}</p>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <Link
              to="/@{$username}/following"
              params={{ username: linkHandle }}
              className="hover:underline"
            >
              <span className="font-bold text-foreground">
                {formatCount(profile.followingCount)}
              </span>{" "}
              <span className="text-muted-foreground">Following</span>
            </Link>
            <Link
              to="/@{$username}/followers"
              params={{ username: linkHandle }}
              className="hover:underline"
            >
              <span className="font-bold text-foreground">
                {formatCount(profile.followerCount)}
              </span>{" "}
              <span className="text-muted-foreground">
                {profile.followerCount === 1 ? "Follower" : "Followers"}
              </span>
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              <span>Joined {formatJoinDate(profile.createdAt)}</span>
            </div>
            {/* Email is the caller's own, out of the session — `byUsername` is
                a public endpoint and deliberately never returns it. */}
            {isOwnProfile && session?.user.email && (
              <div className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" />
                <span>{session.user.email}</span>
              </div>
            )}
          </div>
        </div>

        <SegmentedNav label="Profile sections" className="mb-4">
          <SegmentedNavItem
            active={section === "posts"}
            render={<Link to="/@{$username}" params={{ username: linkHandle }} />}
          >
            Posts
          </SegmentedNavItem>
          <SegmentedNavItem
            active={section === "followers"}
            render={<Link to="/@{$username}/followers" params={{ username: linkHandle }} />}
          >
            Followers
          </SegmentedNavItem>
          <SegmentedNavItem
            active={section === "following"}
            render={<Link to="/@{$username}/following" params={{ username: linkHandle }} />}
          >
            Following
          </SegmentedNavItem>
        </SegmentedNav>

        <Outlet />
      </div>
    </div>
  );
}
