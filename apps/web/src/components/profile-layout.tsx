import { useState } from "react";
import { getRouteApi, Link, Outlet } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ProfileGameRail } from "@/components/profile-game-rail";
import { ORPCError } from "@orpc/client";
import { BANNER_ASPECT_RATIO } from "@my-tuums/api/constants";
import {
  BANNER_FRAME_MAX_HEIGHT,
  BANNER_FRAME_MAX_WIDTH,
  BANNER_FRAME_MIN_HEIGHT,
} from "@/lib/banner-frame";
import { viewerAtom, isStaffAtom } from "@/atoms/session";
import { profileAtomFamily } from "@/atoms/profile";
import { blockDialogAtom, reportDialogAtom, unbanUserAtom } from "@/atoms/moderation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatJoinDate } from "@/lib/format";
import { handleOf } from "@/lib/user";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import { ImageViewer } from "@/components/image-viewer";
import { AvatarUpgradePrompt } from "@/components/avatar-upgrade-prompt";
import { FollowButton } from "@/components/follow-button";
import { FollowListDialog } from "@/components/follow-list-dialog";
import { ProfileBadges } from "@/components/profile-badges";
import { ProfileMessage } from "@/components/profile-message";
import { LinkedText } from "@/components/linked-text";
import { useDocumentHead } from "@/hooks/use-document-head";
import {
  UserX,
  Calendar,
  Loader2,
  AlertCircle,
  Settings,
  MoreHorizontal,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import { profilePageDescription } from "@/lib/document-head";

const routeApi = getRouteApi("/@{$username}");

/**
 * The persistent half of a profile: banner, avatar, name and follow state. The
 * body — the person's posts — is the nested index route rendered through
 * `<Outlet />`. The follower and following lists are not sections of the page;
 * they open in a modal off the counts below (see ./follow-list-dialog.tsx).
 */
export function ProfileLayout() {
  const { username } = routeApi.useParams();
  const viewer = useAtomValue(viewerAtom);
  const setReportDialog = useSetAtom(reportDialogAtom);
  const setBlockDialog = useSetAtom(blockDialogAtom);
  const isStaff = useAtomValue(isStaffAtom);
  const unbanUser = useAtomValue(unbanUserAtom);
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);

  const profileQuery = useAtomValue(profileAtomFamily(username));
  const documentHandle = handleOf(profileQuery.data) || username;
  useDocumentHead(
    `@${documentHandle}`,
    profilePageDescription(profileQuery.data?.suspended ? undefined : profileQuery.data?.bio),
  );

  if (profileQuery.isPending) {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <Loader2 className="text-primary dark:text-link h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (profileQuery.isError) {
    const notFound =
      profileQuery.error instanceof ORPCError && profileQuery.error.code === "NOT_FOUND";

    return notFound ? (
      <ProfileMessage icon={UserX} title={`@${username}`}>
        <p className="text-muted-foreground mb-6 text-sm">{m.profile_not_found()}</p>
        <Button nativeButton={false} render={<Link to="/" className="w-full justify-center" />}>
          {m.common_back_to_home()}
        </Button>
      </ProfileMessage>
    ) : (
      <ProfileMessage icon={AlertCircle} title={m.profile_load_error()}>
        <p className="text-muted-foreground mb-6 text-sm">
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
  const handle = handleOf(profile) || username;
  const displayName = profile.name || handle;
  const hasViewableAvatar = Boolean(profile.image && failedAvatarUrl !== profile.image);

  // The `suspended` flag is the server's contract for a banned profile (see
  // `user.byUsername`): the profile resolves instead of 404ing, and the page
  // renders a stub rather than the full profile — no bio, no counts, no
  // Follow affordance. The account cannot sign in while the ban holds, so
  // the stub never needs to explain itself to its own owner. For the staff
  // who imposed the sentence, the same stub is the one place to lift it:
  // the gate mirrors `moderation.unbanUser`'s own gate (`staffProcedure`,
  // packages/api/src/procedures.ts) — the tier that can impose a ban is the
  // tier that can undo it, so the button never renders for a role the
  // server would 403. On success the mutation's cache sweep refetches
  // `user.byUsername`, and the stub swaps back to the full profile.
  if (profile.suspended) {
    return (
      <ProfileMessage icon={ShieldAlert} title={`@${handle}`}>
        <p className="text-muted-foreground mb-6 text-sm">{m.profile_suspended_body()}</p>
        {isStaff && (
          <div className="mb-6 space-y-2">
            {unbanUser.isError && (
              <p role="alert" className="text-destructive text-xs">
                {unbanUser.error?.message || m.common_something_went_wrong()}
              </p>
            )}
            <Button
              variant="outline"
              className="w-full"
              disabled={unbanUser.isPending}
              onClick={() => unbanUser.mutate({ userId: profile.id })}
            >
              {unbanUser.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              {m.moderation_unban()}
            </Button>
          </div>
        )}
        <Button nativeButton={false} render={<Link to="/" className="w-full justify-center" />}>
          {m.common_back_to_home()}
        </Button>
      </ProfileMessage>
    );
  }

  return (
    <div className="bg-background min-h-screen pb-12">
      {/* The plain `bg-muted` plate is the fallback, not a placeholder: most
          profiles have no banner, and it is what the avatar's negative margin
          and the border below are laid out against either way. The frame is
          the canonical 3:1 with its height clamped; the constants and their
          responsive tradeoffs live in `lib/banner-frame.ts`. */}
      <div
        className="bg-muted border-border relative mx-auto w-full overflow-hidden border-b"
        style={{
          aspectRatio: BANNER_ASPECT_RATIO,
          maxWidth: BANNER_FRAME_MAX_WIDTH,
          minHeight: BANNER_FRAME_MIN_HEIGHT,
          maxHeight: BANNER_FRAME_MAX_HEIGHT,
        }}
      >
        {profile.bannerImage && (
          <img
            src={profile.bannerImage}
            alt={m.profile_banner_alt({ name: displayName })}
            className="h-full w-full object-cover"
          />
        )}
      </div>

      <div className="mx-auto max-w-[1500px] px-4 sm:px-8">
        {/* Avatar & Action buttons */}
        <div className="relative -mt-16 mb-4 flex items-end justify-between sm:-mt-20">
          {hasViewableAvatar && profile.image ? (
            <ImageViewer
              src={profile.image}
              alt={m.profile_avatar_alt({ name: displayName })}
              title={m.profile_avatar_title({ name: displayName })}
              description={m.profile_avatar_view({ name: displayName })}
              triggerLabel={m.profile_avatar_view({ name: displayName })}
              triggerClassName="focus-visible:ring-ring/60 rounded-full focus-visible:ring-2"
            >
              <UserAvatar
                user={profile}
                alt={m.profile_avatar_alt({ name: displayName })}
                className="border-background ring-primary/20 bg-background h-28 w-28 border-4 shadow-xl ring-2 sm:h-36 sm:w-36"
                fallbackClassName="text-2xl sm:text-3xl font-bold bg-primary text-primary-foreground"
                onImageLoadingStatusChange={(status) => {
                  if (status === "error") setFailedAvatarUrl(profile.image);
                }}
              />
            </ImageViewer>
          ) : (
            <UserAvatar
              user={{ name: profile.name, image: null }}
              alt={displayName}
              className="border-background ring-primary/20 bg-background h-28 w-28 border-4 shadow-xl ring-2 sm:h-36 sm:w-36"
              fallbackClassName="text-2xl sm:text-3xl font-bold bg-primary text-primary-foreground"
            />
          )}

          {isOwnProfile ? (
            <div className="mb-2 flex gap-2.5">
              {/* Was a dead button — now the way into /settings/account, where
                  two-factor and passkeys live. The header's account menu
                  (header.tsx) is the other entry point; this one stays so the
                  destination is visible on the page itself, not only behind a
                  menu. Sign-out deliberately does not follow it here: the
                  account menu is on every page, and /settings/account carries
                  the card for it (issue #282). */}
              <Button
                variant="outline"
                size="sm"
                className="border-muted-foreground/30 gap-2 rounded-full"
                nativeButton={false}
                render={<Link to="/settings/account" />}
              >
                <Settings className="h-4 w-4" />
                <span>{m.profile_settings()}</span>
              </Button>
            </div>
          ) : (
            <div className="mb-2 flex items-center gap-2">
              <FollowButton userId={profile.id} isFollowing={profile.viewerIsFollowing} />
              {/* Report and Block on someone else's profile — same shared
                  dialogs as the post card's kebab (see `atoms/moderation.ts`). */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={m.moderation_kebab()}
                  title={m.moderation_kebab()}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex h-9 w-9 cursor-pointer items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={() => setReportDialog({ targetType: "user", targetId: profile.id })}
                  >
                    {m.moderation_kebab_report_author()}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="cursor-pointer"
                    variant="destructive"
                    onClick={() => setBlockDialog({ userId: profile.id, handle })}
                  >
                    {m.moderation_kebab_block()}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {/* The pre-#233 avatar re-crop offer. Own profile only, and only when
            an original exists to seed the editor from (see the component). */}
        {isOwnProfile && profile.image && (
          <AvatarUpgradePrompt
            avatarUrl={profile.image}
            originalUrl={viewer?.imageOriginal ?? null}
          />
        )}

        {/* Profile Info */}
        <div className="mb-6 space-y-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{displayName}</h1>
              {/* Earned badges (issue #308) — the API's display set, already
                  in canonical order; nothing renders for a badge-less
                  profile. */}
              <ProfileBadges badges={profile.badges} iconClassName="size-5" />
            </div>
            <p className="text-muted-foreground text-sm font-medium">@{handle}</p>
          </div>

          {/* `whitespace-pre-line` keeps authored line breaks. LinkedText
              emits React text children and profile links rather than HTML, so
              linkification does not create an escaping boundary. */}
          {profile.bio && (
            <p className="max-w-2xl text-sm leading-relaxed whitespace-pre-line">
              <LinkedText text={profile.bio} />
            </p>
          )}

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

          <div className="text-muted-foreground flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              <span>
                {m.profile_joined({ date: formatJoinDate(profile.createdAt, getLocale()) })}
              </span>
            </div>
          </div>
        </div>

        {/* The favorites rail's mobile half (issue #314, Q25): a horizontal
            cover strip between the profile header and the feed. Renders
            nothing when the profile has no favorites — the rail decides, not
            the layout. The desktop half is the aside below. */}
        <div className="mb-6 lg:hidden">
          <ProfileGameRail username={username} />
        </div>

        {/* Desktop: the feed and the rail's column half share one grid —
            the feed keeps the left, the rail sits beside it (Q11's "a column
            parallel to the feed on its right side"). */}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-8">
          <Outlet />
          <aside className="hidden lg:block">
            <ProfileGameRail username={username} />
          </aside>
        </div>
      </div>
    </div>
  );
}
