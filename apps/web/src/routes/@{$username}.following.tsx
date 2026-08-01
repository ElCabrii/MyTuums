import { createFileRoute } from "@tanstack/react-router";
import { UserList } from "@/components/user-list";

export const Route = createFileRoute("/@{$username}/following")({
  component: ProfileFollowing,
});

/** Exported for ./profile-following.test.tsx. */
export function ProfileFollowing() {
  const { username } = Route.useParams();

  return (
    <UserList
      username={username}
      direction="following"
      emptyMessage={`@${username} isn't following anyone yet.`}
    />
  );
}
