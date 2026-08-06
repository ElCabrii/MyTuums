import { lazy, Suspense } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { MessageSquare, Bell, Compass, Home, Settings, LogOut, Loader2, User, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchBox } from "@/components/search-box";
import { isModeratorAtom, viewerAtom, viewerHandleAtom } from "@/atoms/session";
import { authPendingAtom, signOutAtom } from "@/atoms/auth";
import { UserAvatar } from "@/components/user-avatar";
import { VersionTag } from "@/components/version-tag";
import { m } from "@/paraglide/messages.js";

// The theme dropdown ships its own popover machinery (floating-ui + focus
// management); loading it on demand keeps that weight out of the first paint.
// The account menu below stays in the header chunk on purpose — it is small
// and holds the only sign-out affordance visible on every page. The named
// export is mapped to `default` so the dynamic module can be rendered as a
// lazy component.
const ModeToggle = lazy(() =>
  import("@/components/mode-toggle").then((mod) => ({ default: mod.ModeToggle }))
);

/**
 * The signed-in chrome. Rendered by `__root.tsx` only when a session exists,
 * so it never shows Log in / Register buttons to anyone — the else branch
 * that used to sit here is gone, and there is deliberately no third view to
 * reintroduce it. The early return below is not a second gate; it is the
 * type narrowing that lets the rest of the component read `user` unguarded.
 *
 * `/welcome` keeps the header (the session exists, the handle doesn't) — the
 * avatar links there, and `useRequireHandle` is sending the session there
 * anyway, so the header agrees with the redirect rather than contradicting
 * it (see the regression pinned in `e2e/tests/specs/welcome.spec.ts`).
 */
export function Header() {
  const navigate = useNavigate();
  const user = useAtomValue(viewerAtom);
  const handle = useAtomValue(viewerHandleAtom);
  const isSigningOut = useAtomValue(authPendingAtom);
  const isModerator = useAtomValue(isModeratorAtom);
  const signOut = useSetAtom(signOutAtom);

  if (!user) return null;

  const nameDisplay = user.name || user.displayUsername || user.username || m.nav_profile();

  const handleSignOut = async () => {
    try {
      // Same path as the profile page's sign-out button: signOutAtom
      // (atoms/auth.ts) owns the call, the QueryClient.clear(), and the
      // family sweep; only the final navigate lives here.
      await signOut();
      void navigate({ to: "/login" });
    } catch (err) {
      console.error("Failed to sign out", err);
    }
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="w-full flex h-16 items-center justify-between gap-2 sm:gap-4 px-4 sm:px-8">
        {/* Left Section: Logo & Nav Links.
            `min-w-0` (rather than `shrink-0`) is what keeps the header from
            overflowing the viewport on narrow screens: the right-hand actions
            are the ones that must stay reachable, so the brand is the part
            that yields, truncating its wordmark as a last resort instead of
            pushing sign-in off-screen and making the page scroll sideways. */}
        {/* `xl:flex-1` gives the left and right sections the same flex share
            as the search bar (all three grow from basis 0), so the middle
            lands exactly on the viewport center instead of in the leftover
            gap — a `justify-between` row centers the box only when the sides
            happen to be equally wide, which they never are. Below `xl` the
            bar keeps taking the leftover room, where the sides would not fit
            in equal thirds anyway. */}
        <div className="flex items-center gap-6 min-w-0 xl:flex-1">
          <Link to="/" className="flex items-center gap-2 font-bold text-xl tracking-tight text-primary dark:text-foreground min-w-0">
            <img
              src="/mytuums.svg"
              alt={m.app_logo_alt()}
              width={2048}
              height={2048}
              className="h-7 w-auto shrink-0"
            />
            <span className="truncate">MyTuums</span>
            {/* Pre-1.0 builds are tagged next to the wordmark (alpha/beta);
                stable builds render nothing. The `shrink-0` lives on the tag
                so the wordmark's truncate can never swallow it. */}
            <VersionTag />
          </Link>
          <nav className="hidden md:flex items-center gap-1">
            <Button variant="ghost" nativeButton={false} render={<Link to="/" className="flex items-center gap-2" />}>
              <Home className="h-4 w-4" />
              <span>{m.nav_home()}</span>
            </Button>
            <Button variant="ghost" nativeButton={false} render={<Link to="/discover" className="flex items-center gap-2" />}>
              <Compass className="h-4 w-4" />
              <span>{m.nav_discover()}</span>
            </Button>
            {isModerator && (
              <Button variant="ghost" nativeButton={false} render={<Link to="/moderation" className="flex items-center gap-2" />}>
                <Shield className="h-4 w-4" />
                <span>{m.moderation_nav()}</span>
              </Button>
            )}
          </nav>
        </div>

        {/* Center Section: Search Bar. Held back until `lg`: between `md` and
            `lg` the Home/Discover nav has already appeared, and squeezing the
            search in alongside it collapsed the input to a stub and forced the
            brand wordmark to truncate. `min-w-0` lets it shrink once shown (a
            `flex-1` item defaults to `min-width: auto`, so without it the
            input's intrinsic width becomes a hard floor). */}
        <div className="hidden lg:block flex-1 min-w-0 max-w-md mx-2 sm:mx-4">
          <SearchBox />
        </div>

        {/* Right Section: Messages, Notifications, Theme Toggle, Auth / Profile */}
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0 xl:flex-1 xl:justify-end">
          <Button
            variant="ghost"
            size="icon"
            title={m.nav_messages()}
            aria-label={m.nav_messages()}
            className="hidden sm:inline-flex"
          >
            <MessageSquare className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title={m.nav_notifications()}
            aria-label={m.nav_notifications()}
            className="hidden sm:inline-flex"
          >
            <Bell className="h-5 w-5" />
          </Button>
          
          {/* The fallback is a plain, non-focusable div sized to the icon
              button (size-9) so the sticky header row doesn't shift while the
              lazy chunk loads. */}
          <Suspense fallback={<div className="h-9 w-9 shrink-0" aria-hidden="true" />}>
            <ModeToggle />
          </Suspense>

          {/* The destination branches on the handle, not on `user` — `user`
              exists by the early return above. An OAuth sign-up has no handle
              until it claims one at /welcome: the avatar stays a plain link
              to /welcome in that window, which is also where
              `useRequireHandle` is sending the session, so the header agrees
              with the redirect rather than contradicting it (see the
              regression pinned in e2e/tests/specs/welcome.spec.ts). Once a
              handle exists, the pill becomes the account menu — View profile,
              Settings, Sign out — instead of a bare link. */}
          {handle ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                title={m.user_view_profile({ name: nameDisplay })}
                className="flex items-center gap-2.5 p-1 rounded-full hover:bg-muted/60 transition-colors ml-1 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <UserAvatar
                  user={user}
                  alt={user.name || m.user_avatar_alt()}
                  className="h-8 w-8 border border-primary/20"
                  fallbackClassName="text-xs font-bold bg-primary text-primary-foreground"
                />
                <span className="hidden sm:inline text-sm font-medium pr-1 text-foreground max-w-[140px] truncate">
                  {nameDisplay}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {/* Menu items render real links, so the profile and settings
                    destinations keep link semantics (middle-click, open in
                    new tab) instead of going through a navigate() call. */}
                {/* The preset styles menu rows `cursor-default` (base-ui's
                    keyboard-first convention); these rows are links and an
                    action the user will click with a mouse, so they get the
                    pointer back per-item — `components/ui/**` is upstream. */}
                <DropdownMenuItem
                  className="cursor-pointer"
                  render={<Link to="/@{$username}" params={{ username: handle }} />}
                >
                  <User />
                  <span>{m.menu_view_profile()}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  render={<Link to="/settings/account" />}
                >
                  <Settings />
                  <span>{m.profile_settings()}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="cursor-pointer"
                  variant="destructive"
                  disabled={isSigningOut}
                  onClick={() => void handleSignOut()}
                >
                  {isSigningOut ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <LogOut />
                  )}
                  <span>{m.auth_sign_out()}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Link
              to="/welcome"
              className="flex items-center gap-2.5 p-1 rounded-full hover:bg-muted/60 transition-colors ml-1"
              title={m.welcome_finish_setup()}
            >
              <UserAvatar
                user={user}
                alt={user.name || m.user_avatar_alt()}
                className="h-8 w-8 border border-primary/20"
                fallbackClassName="text-xs font-bold bg-primary text-primary-foreground"
              />
              <span className="hidden sm:inline text-sm font-medium pr-1 text-foreground max-w-[140px] truncate">
                {nameDisplay}
              </span>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
