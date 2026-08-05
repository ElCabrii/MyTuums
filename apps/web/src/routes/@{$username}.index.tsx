import { createFileRoute } from "@tanstack/react-router";
import { ProfilePosts } from "@/components/profile-posts";

/** The default profile tab (`/@{$username}/`) — the person's posts, rendered under the profile layout. */
export const Route = createFileRoute("/@{$username}/")({
  component: ProfilePosts,
});
