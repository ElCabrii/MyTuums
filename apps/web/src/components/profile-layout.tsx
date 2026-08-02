import { getRouteApi, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ORPCError } from "@orpc/client";
import { authPendingAtom, signOutAtom } from "@/atoms/auth";
import { viewerAtom } from "@/atoms/session";
import { profileAtomFamily } from "@/atoms/profile";
import { formatJoinDate } from "@/lib/format";
import { handleOf, initialsOf } from "@/lib/user";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FollowButton } from "@/components/follow-button";
import { FollowListDialog } from "@/components/follow-list-dialog";
import { ProfileMessage } from "@/components/profile-message";
import { UserX, Mail, Calendar, LogOut, Loader2, AlertCircle, Settings } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

const routeApi = getRouteApi("/@{$username}");

/**
 * The persistent half of a profile: banner, avatar, name and follow state. The
 * body — the person's posts — is the nested index route rendered through
 * `<Outlet />`. The follower and following lists are not sections of the page;
 * they open in a modal off the counts below (see ./follow-list-dialog.tsx).
 */
export function ProfileLayout() {
  const navigate = useNavigate();
  const { username } = routeApi.useParams();
  const viewer = useAtomValue(viewerAtom);
  const isSigningOut = useAtomValue(authPendingAtom);
  const signOut = useSetAtom(signOutAtom);

  const profileQuery = useAtomValue(profileAtomFamily(username));

  const handleSignOut = async () => {
    try {
      // signOutAtom (atoms/auth.ts) owns the sign-out call, the
      // QueryClient.clear(), and sweeping the profile/feed/user-list
      // families — see its comment for why clearing those matters here:
      // viewer-dependent fields like `viewerIsFollowing` live behind query
      // keys with no viewer identity in them.
      await signOut();
      void navigate({ to: "/login" });
    } catch (err) {
      console.error("Failed to sign out", err);
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
          {m.profile_not_found()}
        </p>
        <Button nativeButton={false} render={<Link to="/" className="w-full justify-center" />}>
          {m.common_back_to_home()}
        </Button>
      </ProfileMessage>
    ) : (
      <ProfileMessage icon={AlertCircle} title={m.profile_load_error()}>
        <p className="text-muted-foreground text-sm mb-6">
          {profileQuery.error.message || m.common_something_went_wrong()}
        </p>
        <Button variant="outline" onClick={() => void profileQuery.refetch()} className="w-full">
          {m.common_try_again()}
        </Button>
      </ProfileMessage>
    );
  }

  const profile = profileQuery.data;
  const isOwnProfile = viewer?.id === profile.id;
  const handle = profile.displayUsername || handleOf(profile) || username;
  const displayName = profile.name || handle;
  const initials = initialsOf(displayName);

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
              {/* Was a dead button — now the way into /settings/account, where
                  two-factor and passkeys live. It stays the only entry point on
                  purpose: the header has no account menu, and adding one is a
                  navigation change rather than an auth change. */}
              <Button
                variant="outline"
                size="sm"
                className="gap-2 rounded-full border-muted-foreground/30"
                nativeButton={false}
                render={<Link to="/settings/account" />}
              >
                <Settings className="h-4 w-4" />
                <span>{m.profile_settings()}</span>
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleSignOut()}
                disabled={isSigningOut}
                className="gap-2 rounded-full"
              >
                {isSigningOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                <span>{m.auth_sign_out()}</span>
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
            <FollowListDialog
              username={username}
              handle={handle}
              direction="following"
              count={profile.followingCount}
            />
            <FollowListDialog
              username={username}
              handle={handle}
              direction="followers"
              count={profile.followerCount}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              <span>{m.profile_joined({ date: formatJoinDate(profile.createdAt, getLocale()) })}</span>
            </div>
            {/* Email is the caller's own, out of the session — `byUsername` is
                a public endpoint and deliberately never returns it. */}
            {isOwnProfile && viewer?.email && (
              <div className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" />
                <span>{viewer.email}</span>
              </div>
            )}
          </div>
        </div>

        <Outlet />
      </div>
    </div>
  );
}
