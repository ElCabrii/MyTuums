import { getRouteApi } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { MessageSquare } from "lucide-react";
import { viewerIdAtom } from "@/atoms/session";
import { profileAtomFamily } from "@/atoms/profile";
import { postFeedAtom, type PostFeedParams } from "@/atoms/post-feed";
import { handleOf } from "@/lib/user";
import { PostComposer } from "@/components/post-composer";
import { PostFeed } from "@/components/post-feed";
import { SegmentedControl, SegmentedControlItem } from "@/components/segmented-control";
import { m } from "@/paraglide/messages.js";

const routeApi = getRouteApi("/@{$username}/");

type ProfilePostsFilter = "all" | "posts" | "reply";

/**
 * The default profile tab. The surrounding header lives in the layout route
 * (./@{$username}.tsx), so this is only the body.
 */
export function ProfilePosts() {
  const { username } = routeApi.useParams();
  const { filter = "all" } = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
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
  const feedParams: PostFeedParams =
    filter === "posts"
      ? { authorId: profile.id, feed: "global", kind: "posts" }
      : filter === "reply"
        ? { authorId: profile.id, feed: "global", kind: "replies" }
        : { authorId: profile.id, feed: "global", includeReplies: true };
  const emptyMessage =
    filter === "reply"
      ? isOwnProfile
        ? m.profile_own_replies_empty()
        : m.profile_replies_empty({ handle })
      : isOwnProfile
        ? m.profile_own_empty()
        : m.profile_empty({ handle });

  const selectFilter = (next: ProfilePostsFilter) => {
    void navigate({
      search: { filter: next },
      replace: true,
    });
  };

  return (
    <div className="space-y-4">
      <div className="border-border flex items-center gap-2 border-b pb-2">
        <MessageSquare className="text-foreground h-4 w-4" />
        <h2 className="text-foreground text-sm font-bold">{m.profile_posts_heading()}</h2>
      </div>

      <SegmentedControl label={m.profile_posts_filter_label()}>
        <SegmentedControlItem active={filter === "all"} onClick={() => selectFilter("all")}>
          {m.profile_posts_filter_all()}
        </SegmentedControlItem>
        <SegmentedControlItem active={filter === "posts"} onClick={() => selectFilter("posts")}>
          {m.profile_posts_filter_posts()}
        </SegmentedControlItem>
        <SegmentedControlItem active={filter === "reply"} onClick={() => selectFilter("reply")}>
          {m.profile_posts_filter_reply()}
        </SegmentedControlItem>
      </SegmentedControl>

      {isOwnProfile && filter !== "reply" && <PostComposer />}

      {/*
        The selected profile view maps to the corresponding `post.list` mode;
        the home timelines remain top-level-only. See the input's doc comment
        in packages/api/src/posts.ts.
      */}
      <PostFeed feedAtom={postFeedAtom(feedParams)} emptyMessage={emptyMessage} showParentContext />
    </div>
  );
}
