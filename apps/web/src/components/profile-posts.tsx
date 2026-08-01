import { getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { orpc, retryUnlessClientError } from "@/lib/orpc";
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
  const { data: session } = useSession();

  // The same query the layout already ran, with an identical key — TanStack
  // dedupes it, so this reads the cache rather than issuing a second request.
  // Fetching it here keeps the component self-contained and matches the
  // codebase's "fetch in the component" convention.
  const profileQuery = useQuery({
    ...orpc.user.byUsername.queryOptions({ input: { username } }),
    retry: retryUnlessClientError,
  });

  const profile = profileQuery.data;
  if (!profile) return null;

  const isOwnProfile = session?.user.id === profile.id;
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
