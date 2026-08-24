import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ProfilePosts } from "@/components/profile-posts";

/** The default profile tab (`/@{$username}/`) — the person's posts, rendered under the profile layout. */
export const Route = createFileRoute("/@{$username}/")({
  component: ProfilePosts,
  /** Keep the selected activity view in the URL so profile links are shareable. */
  validateSearch: (search) => profilePostsSearchSchema.parse(search),
});

const profilePostsSearchSchema = z.object({
  // The values mirror the tab labels (All / Posts / Reply). `.catch()` degrades
  // links minted before the relabel (`both`, `replies`) to the default view
  // instead of erroring the route.
  filter: z.enum(["all", "posts", "reply"]).optional().catch(undefined),
});
