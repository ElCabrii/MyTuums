import { Link } from "@tanstack/react-router";
import { MessageSquare, Bell, LogIn, Compass, Home, Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModeToggle } from "@/components/mode-toggle";
import { useSession } from "@/lib/auth-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export function Header() {
  const { data: session } = useSession();
  const user = session?.user
    ? (session.user as typeof session.user & {
        username?: string;
        displayUsername?: string;
      })
    : undefined;

  const usernameDisplay = user?.username || user?.displayUsername || user?.name || "Profile";
  const initials = user?.name
    ? user.name
        .split(" ")
        .map((n: string) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U";

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="w-full flex h-16 items-center justify-between gap-4 px-4 sm:px-8">
        {/* Left Section: Logo & Nav Links */}
        <div className="flex items-center gap-6 shrink-0">
          <Link to="/" className="flex items-center gap-2 font-bold text-xl tracking-tight text-primary">
            <img src="/mytuums.svg" alt="MyTuums Logo" className="h-7 w-auto" />
            <span>MyTuums</span>
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

        {/* Center Section: Search Bar */}
        <div className="flex-1 max-w-md mx-2 sm:mx-4">
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
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <Button variant="ghost" size="icon" title="Messages" aria-label="Messages">
            <MessageSquare className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" title="Notifications" aria-label="Notifications">
            <Bell className="h-5 w-5" />
          </Button>
          
          <ModeToggle />

          {user ? (
            <Link
              to="/profile"
              className="flex items-center gap-2.5 p-1 rounded-full hover:bg-muted/60 transition-colors ml-1"
              title={`View profile for ${usernameDisplay}`}
            >
              <Avatar className="h-8 w-8 border border-primary/20">
                <AvatarImage src={user.image || undefined} alt={user.name || "User avatar"} />
                <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="hidden sm:inline text-xs font-medium pr-1 text-foreground max-w-[100px] truncate">
                {usernameDisplay}
              </span>
            </Link>
          ) : (
            <div className="flex items-center gap-2 ml-1 sm:ml-2">
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link to="/login" className="gap-1.5" />}
              >
                <LogIn className="h-4 w-4" />
                <span>Log in</span>
              </Button>
              <Button
                variant="default"
                size="sm"
                nativeButton={false}
                render={<Link to="/register" className="gap-1.5" />}
              >
                <UserPlus className="h-4 w-4" />
                <span>Register</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
