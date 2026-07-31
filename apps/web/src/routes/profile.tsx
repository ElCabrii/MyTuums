import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { authClient, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  User,
  Mail,
  Calendar,
  LogOut,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  LogIn,
  UserPlus,
  Gamepad2,
  Bookmark,
  Activity,
} from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/profile")({
  component: ProfilePage,
});

function ProfilePage() {
  const navigate = useNavigate();
  const { data: session, isPending } = useSession();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      void navigate({ to: "/login" });
    } catch (err) {
      console.error("Failed to sign out:", err);
    } finally {
      setIsSigningOut(false);
    }
  };

  if (isPending) {
    return (
      <div className="container max-w-4xl mx-auto px-4 py-16 flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading profile information...</p>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="container max-w-md mx-auto px-4 py-16">
        <div className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-8 text-center shadow-2xl space-y-6">
          <div className="mx-auto size-16 rounded-full bg-primary/10 flex items-center justify-center text-primary">
            <User className="size-8" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight">Authentication Required</h1>
            <p className="text-sm text-muted-foreground">
              You must be logged in to view your profile and account settings.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <Button
              variant="default"
              nativeButton={false}
              render={<Link to="/login" className="flex-1 gap-2" />}
            >
              <LogIn className="h-4 w-4" />
              <span>Log In</span>
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/register" className="flex-1 gap-2" />}
            >
              <UserPlus className="h-4 w-4" />
              <span>Register</span>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const user = session.user;

  const usernameDisplay = user.username || user.displayUsername || "user";
  const initials = user.name
    ? user.name
        .split(" ")
        .map((n: string) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U";

  const memberSince = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "Recently";

  return (
    <div className="container max-w-4xl mx-auto px-4 py-10 space-y-8">
      {/* Profile Header Card */}
      <section
        aria-label="User Profile Overview"
        className="relative overflow-hidden rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 sm:p-8 shadow-2xl space-y-6"
      >
        <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6">
          <Avatar className="size-24 border-2 border-primary/20 shadow-lg">
            <AvatarImage src={user.image || undefined} alt={user.name || "User avatar"} />
            <AvatarFallback className="text-2xl font-bold bg-primary/10 text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 text-center sm:text-left space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
                {user.name}
              </h1>
              <Badge variant="secondary" className="w-fit mx-auto sm:mx-0 font-normal">
                @{usernameDisplay}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-4 text-xs sm:text-sm text-muted-foreground pt-1">
              <div className="flex items-center gap-1.5">
                <Mail className="h-4 w-4 shrink-0 text-primary/80" />
                <span>{user.email}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Calendar className="h-4 w-4 shrink-0 text-primary/80" />
                <span>Joined {memberSince}</span>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-center sm:justify-start gap-2">
              {user.emailVerified ? (
                <Badge variant="default" className="gap-1.5 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border-emerald-500/20">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>Email Verified</span>
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1.5 text-amber-500 border-amber-500/30">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  <span>Email Unverified</span>
                </Badge>
              )}
            </div>
          </div>

          <div className="shrink-0 w-full sm:w-auto">
            <Button
              variant="outline"
              onClick={() => void handleSignOut()}
              disabled={isSigningOut}
              className="w-full sm:w-auto gap-2 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {isSigningOut ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Signing out...</span>
                </>
              ) : (
                <>
                  <LogOut className="h-4 w-4" />
                  <span>Sign Out</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </section>

      {/* Accessible Empty Content Sections */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <section
          aria-label="My Games"
          className="rounded-3xl border border-border/40 bg-card/40 p-6 space-y-4 shadow-sm"
        >
          <div className="flex items-center gap-2.5 text-foreground font-semibold text-base">
            <div className="p-2 rounded-xl bg-primary/10 text-primary">
              <Gamepad2 className="h-5 w-5" />
            </div>
            <h2>My Games</h2>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Connect your gaming accounts or track your favorite games.
          </p>
          <div className="rounded-2xl border border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
            No games added yet
          </div>
        </section>

        <section
          aria-label="Saved Clips"
          className="rounded-3xl border border-border/40 bg-card/40 p-6 space-y-4 shadow-sm"
        >
          <div className="flex items-center gap-2.5 text-foreground font-semibold text-base">
            <div className="p-2 rounded-xl bg-primary/10 text-primary">
              <Bookmark className="h-5 w-5" />
            </div>
            <h2>Bookmarks</h2>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Your saved highlights, posts, and bookmarks will appear here.
          </p>
          <div className="rounded-2xl border border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
            No bookmarks saved yet
          </div>
        </section>

        <section
          aria-label="Activity Log"
          className="rounded-3xl border border-border/40 bg-card/40 p-6 space-y-4 shadow-sm"
        >
          <div className="flex items-center gap-2.5 text-foreground font-semibold text-base">
            <div className="p-2 rounded-xl bg-primary/10 text-primary">
              <Activity className="h-5 w-5" />
            </div>
            <h2>Activity Log</h2>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Recent interactions and community activity.
          </p>
          <div className="rounded-2xl border border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
            No recent activity recorded
          </div>
        </section>
      </div>
    </div>
  );
}
