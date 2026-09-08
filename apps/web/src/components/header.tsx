import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Bell, Compass, Gamepad2, Home, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchBox } from "@/components/search-box";
import { AccountMenu } from "@/components/account-menu";
import { unreadCountAtom } from "@/atoms/notifications";
import { isModeratorAtom, viewerAtom } from "@/atoms/session";
import { VersionTag } from "@/components/version-tag";
import { m } from "@/paraglide/messages.js";

const ModeToggle = lazy(() =>
  import("@/components/mode-toggle").then((mod) => ({ default: mod.ModeToggle })),
);

/** Signed-in chrome; mobile primary destinations live in MobileNavigation. */
export function Header() {
  const user = useAtomValue(viewerAtom);
  const isModerator = useAtomValue(isModeratorAtom);
  const unread = useAtomValue(unreadCountAtom);
  if (!user) return null;
  const unreadCount = unread.data?.unreadCount ?? 0;
  return (
    <header className="bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 w-full border-b backdrop-blur">
      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 sm:px-8 lg:grid-cols-[auto_minmax(0,1fr)_auto]">
        <div className="flex min-h-16 min-w-0 items-center gap-4 xl:min-w-fit">
          <Link
            to="/"
            aria-label={m.nav_brand_home()}
            className="text-primary dark:text-foreground flex min-h-11 min-w-11 items-center gap-2 text-xl font-bold tracking-tight"
          >
            <img
              src="/mytuums.svg"
              alt={m.app_logo_alt()}
              width={2048}
              height={2048}
              className="h-7 w-auto shrink-0"
            />
            <span className="hidden truncate md:inline xl:overflow-visible">MyTuums</span>
            <span className="hidden md:inline-flex">
              <VersionTag />
            </span>
          </Link>
          <nav aria-label={m.nav_primary()} className="hidden shrink-0 items-center gap-1 md:flex">
            <Button variant="ghost" nativeButton={false} render={<Link to="/" />}>
              <Home className="size-4" />
              {m.nav_home()}
            </Button>
            <Button variant="ghost" nativeButton={false} render={<Link to="/discover" />}>
              <Compass className="size-4" />
              {m.nav_discover()}
            </Button>
            <Button variant="ghost" nativeButton={false} render={<Link to="/games" />}>
              <Gamepad2 className="size-4" />
              {m.nav_games()}
            </Button>
          </nav>
        </div>
        <div className="order-last col-span-2 min-w-0 pb-3 lg:order-none lg:col-span-1 lg:mx-auto lg:w-full lg:max-w-md lg:pb-0">
          <SearchBox />
        </div>
        <div className="flex min-h-16 shrink-0 items-center justify-end gap-1 sm:gap-2">
          <Button
            variant="ghost"
            size="icon"
            nativeButton={false}
            className="size-11"
            render={
              <Link
                to="/notifications"
                title={m.nav_notifications()}
                aria-label={
                  unreadCount > 0
                    ? unreadCount === 1
                      ? m.nav_notifications_unread_one({ count: unreadCount })
                      : m.nav_notifications_unread_many({ count: unreadCount })
                    : m.nav_notifications()
                }
                className="relative"
              />
            }
          >
            <Bell className="size-5" />
            {unreadCount > 0 && (
              <span
                aria-hidden="true"
                className="bg-primary text-primary-foreground absolute top-0 right-0 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Button>
          {isModerator && (
            <Link
              to="/moderation"
              title={m.moderation_nav()}
              aria-label={m.moderation_nav()}
              activeProps={{ className: "bg-muted text-primary" }}
              className="hover:bg-muted focus-visible:ring-ring flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2"
            >
              <Shield className="size-5" />
            </Link>
          )}
          <div className="hidden items-center gap-2 md:flex">
            <Suspense fallback={<div className="size-9" aria-hidden="true" />}>
              <ModeToggle />
            </Suspense>
            <AccountMenu />
          </div>
        </div>
      </div>
    </header>
  );
}
