import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { Bell, Compass, Gamepad2, Home, Mail, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchBox } from "@/components/search-box";
import { AccountMenu } from "@/components/account-menu";
import { unreadCountAtom } from "@/atoms/notifications";
import { messagesUnreadAtom } from "@/atoms/messages";
import { isModeratorAtom, viewerAtom } from "@/atoms/session";
import { VersionTag } from "@/components/version-tag";
import { m } from "@/paraglide/messages.js";

/** Signed-in chrome; mobile primary destinations live in MobileNavigation. */
export function Header() {
  const user = useAtomValue(viewerAtom);
  const isModerator = useAtomValue(isModeratorAtom);
  const unread = useAtomValue(unreadCountAtom);
  const messagesUnread = useAtomValue(messagesUnreadAtom);

  // Publishes the rendered height as `--header-height` (0px fallback in
  // index.css) so sticky sub-headers — the message thread's — can pin below
  // this one instead of hard-coding a height that is content- and
  // breakpoint-driven (single row on mobile, search row + nav row on
  // desktop). Re-runs when auth presence flips, because the header element
  // only exists while signed in.
  const headerRef = useRef<HTMLElement>(null);
  const signedIn = user != null;
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty("--header-height", `${el.offsetHeight}px`);
    publish();
    // jsdom (and other non-layout environments) has no ResizeObserver; the
    // direct publish above still writes the variable there.
    if (!("ResizeObserver" in globalThis)) return;
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => observer.disconnect();
  }, [signedIn]);

  if (!user) return null;
  const unreadCount = unread.data?.unreadCount ?? 0;
  // The messages badge counts inbox conversations only — pending requests
  // never tick it; they carry their own count on the requests entry.
  const messageCount = messagesUnread.data?.unreadCount ?? 0;
  return (
    <header
      ref={headerRef}
      className="bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 w-full border-b pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] backdrop-blur"
    >
      <div className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 px-4 sm:gap-x-4 sm:px-8 md:grid-cols-[minmax(0,1fr)_auto] 2xl:grid-cols-[minmax(0,1fr)_28rem_minmax(0,1fr)]">
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
        <div className="min-w-0 md:order-last md:col-span-2 md:pb-3 2xl:order-none 2xl:col-span-1 2xl:mx-auto 2xl:w-full 2xl:max-w-md 2xl:pb-0">
          <SearchBox />
        </div>
        <div className="flex min-h-16 shrink-0 items-center justify-end gap-1 sm:gap-2">
          <Button
            variant="ghost"
            size="icon"
            nativeButton={false}
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
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span
                aria-hidden="true"
                className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Button>
          {/* The messages Mail action: the same ghost icon badge treatment as
              the bell, one slot to its left (issue #408). The badge is the
              inbox's unread messages; message requests never tick it. */}
          <Button
            variant="ghost"
            size="icon"
            nativeButton={false}
            render={
              <Link
                to="/messages"
                title={m.nav_messages()}
                aria-label={
                  messageCount > 0
                    ? messageCount === 1
                      ? m.nav_messages_unread_one({ count: messageCount })
                      : m.nav_messages_unread_many({ count: messageCount })
                    : m.nav_messages()
                }
                className="relative"
              />
            }
          >
            <Mail className="h-5 w-5" />
            {messageCount > 0 && (
              <span
                aria-hidden="true"
                className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold"
              >
                {messageCount > 99 ? "99+" : messageCount}
              </span>
            )}
          </Button>
          {/* The moderation entry is the same ghost icon button as the bell —
              hand-rolling it as a bare link left it a size and a hit-area
              apart from every icon around it. The unsized Shield picks up the
              Button's 16px SVG rule, matching the rest of the row. */}
          {isModerator && (
            <Button
              variant="ghost"
              size="icon"
              nativeButton={false}
              render={
                <Link
                  to="/moderation"
                  title={m.moderation_nav()}
                  aria-label={m.moderation_nav()}
                  activeProps={{ className: "bg-muted text-primary" }}
                />
              }
            >
              <Shield />
            </Button>
          )}
          <div className="hidden items-center gap-2 md:flex">
            <AccountMenu />
          </div>
        </div>
      </div>
    </header>
  );
}
