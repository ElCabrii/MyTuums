import { createFileRoute } from "@tanstack/react-router";
import { ProfilePosts } from "@/components/profile-posts";

export const Route = createFileRoute("/@{$username}/")({
  component: ProfilePosts,
});
