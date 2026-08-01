import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { MessageSquare, Bell, LogIn, Compass, Home, Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModeToggle } from "@/components/mode-toggle";
import { viewerAtom, viewerHandleAtom, viewerInitialsAtom } from "@/atoms/session";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export function Header() {
  const user = useAtomValue(viewerAtom);
  const handle = useAtomValue(viewerHandleAtom);
  const initials = useAtomValue(viewerInitialsAtom);

  const nameDisplay = user?.name || user?.displayUsername || user?.username || "Profile";

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="w-full flex h-16 items-center justify-between gap-2 sm:gap-4 px-4 sm:px-8">
        {/* Left Section: Logo & Nav Links.
            `min-w-0` (rather than `shrink-0`) is what keeps the header from
            overflowing the viewport on narrow screens: the right-hand actions
            are the ones that must stay reachable, so the brand is the part
            that yields, truncating its wordmark as a last resort instead of
            pushing sign-in off-screen and making the page scroll sideways. */}
        <div className="flex items-center gap-6 min-w-0">
          <Link to="/" className="flex items-center gap-2 font-bold text-xl tracking-tight text-primary min-w-0">
            <img src="/mytuums.svg" alt="MyTuums Logo" className="h-7 w-auto shrink-0" />
            <span className="truncate">MyTuums</span>
          </Link>
          <nav className="hidden md:flex items-center gap-1">
            <Button variant="ghost" nativeButton={false} render={<Link to="/" className="flex items-center gap-2" />}>
              <Home className="h-4 w-4" />
              <span>Home</span>
            </Button>
            <Button variant="ghost" nativeButton={false} render={<Link to="/discover" className="flex items-center gap-2" />}>
              <Compass className="h-4 w-4" />
              <span>Discover</span>
            </Button>
          </nav>
        </div>

        {/* Center Section: Search Bar. Held back until `lg`: between `md` and
            `lg` the Home/Discover nav has already appeared, and squeezing the
            search in alongside it collapsed the input to a stub and forced the
            brand wordmark to truncate. `min-w-0` lets it shrink once shown (a
            `flex-1` item defaults to `min-width: auto`, so without it the
            input's intrinsic width becomes a hard floor). */}
        <div className="hidden lg:block flex-1 min-w-0 max-w-md mx-2 sm:mx-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search games, clips, or players..."
              className="w-full pl-9 bg-muted/50 focus-visible:bg-background"
            />
          </div>
        </div>

        {/* Right Section: Messages, Notifications, Theme Toggle, Auth / Profile */}
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            title="Messages"
            aria-label="Messages"
            className="hidden sm:inline-flex"
          >
            <MessageSquare className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Notifications"
            aria-label="Notifications"
            className="hidden sm:inline-flex"
          >
            <Bell className="h-5 w-5" />
          </Button>
          
          <ModeToggle />

          {user && handle ? (
            <Link
              to="/@{$username}"
              params={{ username: handle }}
              className="flex items-center gap-2.5 p-1 rounded-full hover:bg-muted/60 transition-colors ml-1"
              title={`View profile for ${nameDisplay}`}
            >
              <Avatar className="h-8 w-8 border border-primary/20">
                <AvatarImage src={user.image || undefined} alt={user.name || "User avatar"} />
                <AvatarFallback className="text-xs font-bold bg-primary text-primary-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="hidden sm:inline text-sm font-medium pr-1 text-foreground max-w-[140px] truncate">
                {nameDisplay}
              </span>
            </Link>
          ) : (
            <div className="flex items-center gap-1.5 sm:gap-2 sm:ml-2">
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link to="/login" className="gap-1.5" />}
              >
                {/* Label-only on phones: the icons are decorative here, and
                    dropping them is what buys the brand wordmark enough room
                    to render untruncated at 375px. */}
                <LogIn className="hidden sm:block h-4 w-4" />
                <span>Log in</span>
              </Button>
              <Button
                variant="default"
                size="sm"
                nativeButton={false}
                render={<Link to="/register" className="gap-1.5" />}
              >
                <UserPlus className="hidden sm:block h-4 w-4" />
                <span>Register</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
