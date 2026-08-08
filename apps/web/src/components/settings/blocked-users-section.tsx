import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { AlertCircle, Loader2, UserX } from "lucide-react";
import { blockedUsersAtom, unblockAtom } from "@/atoms/moderation";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/settings/section";
import { UserAvatar } from "@/components/user-avatar";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

/**
 * The settings card listing everyone the viewer has blocked, newest block
 * first, with one Unblock action per row. Blocking happens from the kebab and
 * profile menus (block-dialog.tsx); this is the reverse surface — the one
 * place the app unblocks, so the list of who you've blocked is visible while
 * you decide.
 */
export function BlockedUsersSection() {
  const blocked = useAtomValue(blockedUsersAtom);
  const unblock = useAtomValue(unblockAtom);

  return (
    <Section
      title={m.settings_blocked_title()}
      description={m.settings_blocked_description()}
      icon={<UserX className="h-5 w-5" />}
    >
      {blocked.isPending ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          {m.settings_blocked_loading()}
        </p>
      ) : blocked.isError ? (
        <div
          role="alert"
          className="border-destructive/20 bg-destructive/10 text-destructive flex items-start gap-3 rounded-xl border p-3 text-sm"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-2">
            <p className="text-xs">{m.settings_blocked_error()}</p>
            <Button variant="outline" size="sm" onClick={() => void blocked.refetch()}>
              {m.common_try_again()}
            </Button>
          </div>
        </div>
      ) : blocked.data.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{m.settings_blocked_empty()}</p>
      ) : (
        <ul className="space-y-2">
          {blocked.data.items.map((user) => {
            const handle = handleOf(user);
            const displayName = user.name || handle || m.user_unknown();
            return (
              <li
                key={user.id}
                className="border-border/50 bg-background/40 flex items-center gap-3 rounded-2xl border px-4 py-2.5"
              >
                <UserAvatar
                  user={user}
                  alt={displayName}
                  className="bg-background h-9 w-9 shrink-0"
                  fallbackClassName="bg-primary text-primary-foreground font-bold text-xs"
                />
                <div className="min-w-0 flex-1">
                  {handle ? (
                    <Link
                      to="/@{$username}"
                      params={{ username: handle }}
                      className="block min-w-0 hover:underline"
                    >
                      <span className="text-foreground block truncate text-sm font-medium">
                        {displayName}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        @{handle}
                      </span>
                    </Link>
                  ) : (
                    <span className="text-foreground block truncate text-sm font-medium">
                      {displayName}
                    </span>
                  )}
                </div>
                {/* One shared mutation: its isPending disables every row, like
                    the linked-accounts list's single busy flag. */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive text-xs"
                  disabled={unblock.isPending}
                  onClick={() => void unblock.mutate({ userId: user.id })}
                >
                  {m.settings_blocked_unblock()}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
