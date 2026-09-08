import { Link } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import {
  Bookmark,
  Ellipsis,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
  User,
} from "lucide-react";
import { viewerAtom, viewerHandleAtom } from "@/atoms/session";
import { authPendingAtom } from "@/atoms/auth";
import { themeAtom } from "@/atoms/theme";
import { useSignOut } from "@/hooks/use-sign-out";
import { UserAvatar } from "@/components/user-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/paraglide/messages.js";

/** Account actions live in the desktop header and on the mobile own-profile page. */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const user = useAtomValue(viewerAtom);
  const handle = useAtomValue(viewerHandleAtom);
  const pending = useAtomValue(authPendingAtom);
  const setTheme = useSetAtom(themeAtom);
  const signOut = useSignOut();
  if (!user) return null;
  const name = user.name || user.displayUsername || user.username || m.nav_profile();
  if (!handle)
    return (
      <Link
        to="/welcome"
        title={m.welcome_finish_setup()}
        aria-label={name}
        className="flex size-11 items-center justify-center rounded-full"
      >
        <UserAvatar user={user} alt={name} className="size-8" />
      </Link>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={compact ? m.nav_account_menu() : m.user_view_profile({ name })}
        aria-label={compact ? m.nav_account_menu() : undefined}
        className="hover:bg-muted/60 focus-visible:ring-ring flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-full p-1 outline-none focus-visible:ring-2"
      >
        {compact ? (
          <Ellipsis className="size-5" />
        ) : (
          <>
            <UserAvatar
              user={user}
              alt={name}
              className="border-primary/20 size-8 border"
              fallbackClassName="bg-primary text-primary-foreground text-xs font-bold"
            />
            <span className="hidden max-w-36 truncate pr-1 text-sm font-medium xl:inline">
              {name}
            </span>
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[var(--available-height)] min-w-48 overflow-y-auto"
      >
        {!compact && (
          <DropdownMenuItem
            className="cursor-pointer"
            render={<Link to="/@{$username}" params={{ username: handle }} />}
          >
            <User />
            {m.menu_view_profile()}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className="cursor-pointer" render={<Link to="/bookmarks" />}>
          <Bookmark />
          {m.nav_bookmarks()}
        </DropdownMenuItem>
        {!compact && (
          <DropdownMenuItem className="cursor-pointer" render={<Link to="/settings/account" />}>
            <Settings />
            {m.profile_settings()}
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Sun />
            {m.theme_toggle()}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <Sun />
              {m.theme_light()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <Moon />
              {m.theme_dark()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")}>
              <Monitor />
              {m.theme_system()}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer"
          variant="destructive"
          disabled={pending}
          onClick={() => void signOut()}
        >
          {pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <LogOut />}
          {m.auth_sign_out()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
