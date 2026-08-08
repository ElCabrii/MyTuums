import { useAtom } from "jotai";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { UserList } from "@/components/user-list";
import { followListDialogAtom, type FollowDirection } from "@/atoms/user-list";
import { formatCount } from "@/lib/format";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

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
  direction: FollowDirection;
  count: number;
}) {
  const [openDialog, setOpenDialog] = useAtom(followListDialogAtom);

  // Derived rather than stored, which is what lets the effect this used to
  // need disappear. Rows in the list link to other profiles, and that
  // navigation happens *underneath* an open dialog — previously the dialog
  // stayed up and quietly reloaded with that person's list, so a `useEffect`
  // force-closed it whenever `username` changed. Now a different handle just
  // makes this comparison false, with no state left over to correct.
  const open = openDialog?.username === username && openDialog.direction === direction;

  const isFollowers = direction === "followers";
  const title = isFollowers ? m.follow_followers() : m.follow_following();
  const label = isFollowers && count === 1 ? m.follow_follower() : title;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpenDialog(next ? { username, direction } : null);
      }}
    >
      <DialogTrigger className="focus-visible:outline-ring rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">
        <span className="text-foreground font-bold">{formatCount(count, getLocale())}</span>{" "}
        <span className="text-muted-foreground">{label}</span>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader className="pb-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isFollowers
              ? m.follow_list_followers_title({ handle })
              : m.follow_list_following_title({ handle })}
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
                ? m.follow_list_followers_empty({ handle })
                : m.follow_list_following_empty({ handle })
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
