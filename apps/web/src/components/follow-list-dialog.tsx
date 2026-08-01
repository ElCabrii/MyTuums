import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { UserList } from "@/components/user-list";
import { formatCount } from "@/lib/format";

/**
 * A follower/following count on a profile, which opens the matching list in a
 * modal rather than navigating to a tab.
 *
 * The list is only mounted while the dialog is open, so opening it is what
 * issues the request — a profile visit doesn't pay for two lists nobody
 * asked for.
 */
export function FollowListDialog({
  username,
  handle,
  direction,
  count,
}: {
  /** The handle from the URL — what the list query is keyed on. */
  username: string;
  /** Display handle, for the copy. May differ from `username` in casing. */
  handle: string;
  /** "followers" = people following them; "following" = people they follow. */
  direction: "followers" | "following";
  count: number;
}) {
  const [open, setOpen] = useState(false);

  // Rows in the list link to other profiles, and that navigation happens
  // underneath an open dialog: on another handle this same dialog would stay
  // up and quietly reload with *that* person's list. Closing on a param change
  // keeps the dialog tied to the profile it was opened from.
  useEffect(() => {
    setOpen(false);
  }, [username]);

  const isFollowers = direction === "followers";
  const title = isFollowers ? "Followers" : "Following";
  const label = isFollowers && count === 1 ? "Follower" : title;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <span className="font-bold text-foreground">{formatCount(count)}</span>{" "}
        <span className="text-muted-foreground">{label}</span>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader className="pb-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isFollowers ? `People following @${handle}` : `People @${handle} follows`}
          </DialogDescription>
        </DialogHeader>

        {/* The list scrolls inside the dialog rather than growing it past the
            viewport — "Load more" can add pages indefinitely. */}
        <div className="max-h-[60vh] overflow-y-auto px-6 pb-6">
          <UserList
            username={username}
            direction={direction}
            emptyMessage={
              isFollowers
                ? `@${handle} doesn't have any followers yet.`
                : `@${handle} isn't following anyone yet.`
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
