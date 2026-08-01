import { getRouteApi } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { MessageSquare } from "lucide-react";
import { viewerIdAtom } from "@/atoms/session";
import { profileAtomFamily } from "@/atoms/profile";
import { handleOf } from "@/lib/user";
import { PostComposer } from "@/components/post-composer";
import { PostFeed } from "@/components/post-feed";

const routeApi = getRouteApi("/@{$username}/");

/**
 * The default profile tab. The surrounding header lives in the layout route
 * (./@{$username}.tsx), so this is only the body.
 */
export function ProfilePosts() {
  const { username } = routeApi.useParams();
  const viewerId = useAtomValue(viewerIdAtom);

  // The layout route reads `profileAtomFamily(username)` too. Dedup is no
  // longer an incidental side effect of two components building the same
  // query key — both read the exact same atom, so there is structurally one
  // observer for this handle, not two that happen to agree. Fetching it here
  // keeps the component self-contained and matches the codebase's "fetch in
  // the component" convention.
  const profileQuery = useAtomValue(profileAtomFamily(username));

  const profile = profileQuery.data;
  if (!profile) return null;

  const isOwnProfile = viewerId === profile.id;
  const handle = handleOf(profile) ?? username;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border">
        <MessageSquare className="h-4 w-4 text-foreground" />
        <h2 className="text-sm font-bold text-foreground">Posts</h2>
      </div>

      {isOwnProfile && <PostComposer />}

      <PostFeed
        authorId={profile.id}
        emptyMessage={
          isOwnProfile
            ? "You haven't posted anything yet."
            : `@${handle} hasn't posted anything yet.`
        }
      />
    </div>
  );
}
