import { createFileRoute } from "@tanstack/react-router";
import { UserList } from "@/components/user-list";

export const Route = createFileRoute("/@{$username}/followers")({
  component: ProfileFollowers,
});

/** Exported for ./profile-followers.test.tsx. */
export function ProfileFollowers() {
  const { username } = Route.useParams();

  return (
    <UserList
      username={username}
      direction="followers"
      emptyMessage={`@${username} doesn't have any followers yet.`}
    />
  );
}
