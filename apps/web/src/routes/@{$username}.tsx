import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ORPCError } from "@orpc/client";
import { authClient, useSession } from "@/lib/auth-client";
import { formatJoinDate } from "@/lib/format";
import { orpc } from "@/lib/orpc";
import { handleOf, initialsOf } from "@/lib/user";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { PostComposer } from "@/components/post-composer";
import { PostFeed } from "@/components/post-feed";
import {
  UserX,
  Mail,
  Calendar,
  LogOut,
  Loader2,
  AlertCircle,
  Gamepad2,
  Trophy,
  Sparkles,
  Award,
  CheckCircle2,
  MessageSquare,
  Settings,
  Tv,
  Zap,
} from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/@{$username}")({
  component: ProfilePage,
});

// Placeholder content. None of this is backed by a table yet, so it renders
// behind a "Sample data" label rather than being presented as this person's
// real ranks and accounts — every profile would otherwise claim to be
// Radiant #420. Delete the label along with the constants once the real
// tables exist.
const BADGES = [
  { id: "verified", name: "Verified Tuumer", icon: CheckCircle2, description: "Verified community creator" },
  { id: "early", name: "Early Supporter", icon: Sparkles, description: "Joined during MyTuums Beta" },
  { id: "radiant", name: "Radiant #420", icon: Trophy, description: "Top 500 Competitive Rank" },
  { id: "pro", name: "Pro Streamer", icon: Tv, description: "Official Twitch Partner" },
  { id: "champion", name: "Tournament Champ", icon: Award, description: "MyTuums Cup 2026 Winner" },
];

const FAVORITE_GAMES = [
  {
    name: "Valorant",
    rank: "Radiant #420",
    role: "Duelist (Jett/Reyna)",
    hours: "1,240 hrs",
    winRate: "68.4%",
    tag: "FPS",
  },
  {
    name: "League of Legends",
    rank: "Grandmaster 312 LP",
    role: "Mid Lane (Syndra/Ahri)",
    hours: "2,150 hrs",
    winRate: "61.2%",
    tag: "MOBA",
  },
  {
    name: "Rocket League",
    rank: "Grand Champion II",
    role: "3v3 / 2v2 Specialist",
    hours: "890 hrs",
    winRate: "59.8%",
    tag: "Sports",
  },
];

const LINKED_ACCOUNTS = [
  { platform: "Steam", username: "ShadowTuumer99", icon: "🎮", status: "Online" },
  { platform: "Discord", username: "AlexGamer#0001", icon: "💬", status: "In-Game (Valorant)" },
  { platform: "Riot Games", username: "ApexPredator#NA1", icon: "⚔️", status: "In Match" },
  { platform: "Twitch", username: "AlexLive_Gaming", icon: "💜", status: "Offline" },
];

function SampleDataBadge() {
  return (
    <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground border border-dashed border-border rounded px-1.5 py-0.5">
      Sample data
    </span>
  );
}

function ProfileMessage({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof UserX;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="container max-w-md mx-auto py-16 px-4">
      <div className="rounded-xl border bg-card p-6 shadow-sm text-center">
        <div className="flex justify-center mb-4">
          <div className="p-3 rounded-full bg-primary/10 text-primary">
            <Icon className="h-8 w-8" />
          </div>
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-1">{title}</h1>
        {children}
      </div>
    </div>
  );
}

// Exported for ./profile.test.tsx: reaching it through `Route.component`
// instead would mean typing against the router's internals.
export function ProfilePage() {
  const navigate = useNavigate();
  const { username } = Route.useParams();
  const { data: session } = useSession();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isAccountsOpen, setIsAccountsOpen] = useState(false);

  const profileQuery = useQuery({
    ...orpc.user.byUsername.queryOptions({ input: { username } }),
    // A handle that doesn't exist won't start existing on the second attempt,
    // and neither will one the server rejected as malformed — only retry the
    // failures that might actually be transient.
    retry: (failureCount, error) =>
      !(error instanceof ORPCError && error.status >= 400 && error.status < 500) &&
      failureCount < 2,
  });

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      void navigate({ to: "/login" });
    } catch (err) {
      console.error("Failed to sign out", err);
    } finally {
      setIsSigningOut(false);
    }
  };

  if (profileQuery.isPending) {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (profileQuery.isError) {
    const notFound =
      profileQuery.error instanceof ORPCError && profileQuery.error.code === "NOT_FOUND";

    return notFound ? (
      <ProfileMessage icon={UserX} title={`@${username}`}>
        <p className="text-muted-foreground text-sm mb-6">
          There's nobody here. This handle isn't taken.
        </p>
        <Button nativeButton={false} render={<Link to="/" className="w-full justify-center" />}>
          Back to home
        </Button>
      </ProfileMessage>
    ) : (
      <ProfileMessage icon={AlertCircle} title="Couldn't load this profile">
        <p className="text-muted-foreground text-sm mb-6">
          {profileQuery.error.message || "Something went wrong."}
        </p>
        <Button variant="outline" onClick={() => void profileQuery.refetch()} className="w-full">
          Try again
        </Button>
      </ProfileMessage>
    );
  }

  const profile = profileQuery.data;
  const isOwnProfile = session?.user.id === profile.id;
  const handle = profile.displayUsername || handleOf(profile) || username;
  const displayName = profile.name || handle;
  const initials = initialsOf(displayName);

  return (
    <div className="min-h-screen bg-background pb-12">
      {/* Banner */}
      <div className="w-full h-48 sm:h-64 relative bg-muted border-b border-border overflow-hidden">
        <div className="absolute bottom-3 right-4">
          <Badge className="bg-background/90 text-foreground border-border gap-1.5 px-3 py-1 shadow-sm">
            <Gamepad2 className="h-3.5 w-3.5 text-primary" />
            <span>Competitive Gamer</span>
          </Badge>
        </div>
      </div>

      <div className="max-w-[1500px] mx-auto px-4 sm:px-8">
        {/* Avatar & Action buttons */}
        <div className="relative flex justify-between items-end -mt-16 sm:-mt-20 mb-4">
          <Avatar className="h-28 w-28 sm:h-36 sm:w-36 border-4 border-background shadow-xl ring-2 ring-primary/20 bg-background">
            <AvatarImage src={profile.image || undefined} alt={displayName} />
            <AvatarFallback className="text-2xl sm:text-3xl font-bold bg-primary text-primary-foreground">
              {initials}
            </AvatarFallback>
          </Avatar>

          {isOwnProfile && (
            <div className="flex gap-2.5 mb-2">
              <Button variant="outline" size="sm" className="gap-2 rounded-full border-muted-foreground/30">
                <Settings className="h-4 w-4" />
                <span>Edit Profile</span>
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleSignOut()}
                disabled={isSigningOut}
                className="gap-2 rounded-full"
              >
                {isSigningOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                <span>Sign out</span>
              </Button>
            </div>
          )}
        </div>

        {/* Profile Info */}
        <div className="space-y-3 mb-6">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{displayName}</h1>
              <div className="flex items-center gap-1.5">
                {BADGES.map(({ id, name, icon: Icon, description }) => (
                  <div
                    key={id}
                    className="p-1.5 rounded-md border border-border bg-secondary text-foreground text-xs font-semibold flex items-center gap-1 shadow-sm hover:bg-muted/80 transition-colors"
                    title={`${name}: ${description} (sample data)`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                ))}
              </div>
            </div>
            <p className="text-muted-foreground text-sm font-medium">@{handle}</p>
          </div>

          <div>
            <button
              onClick={() => setIsAccountsOpen(true)}
              className="inline-flex items-center gap-1.5 hover:text-primary transition-colors text-muted-foreground font-medium text-xs bg-muted/60 hover:bg-muted px-2.5 py-1 rounded-full border border-border"
            >
              <Zap className="h-3.5 w-3.5 text-primary" />
              <span className="font-semibold text-foreground">Linked Accounts</span>
              <span className="text-[10px] bg-background text-foreground px-1.5 py-0.5 rounded-full border border-border font-bold">
                {LINKED_ACCOUNTS.length}
              </span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              <span>Joined {formatJoinDate(profile.createdAt)}</span>
            </div>
            {/* Email is the caller's own, out of the session — `byUsername` is
                a public endpoint and deliberately never returns it. */}
            {isOwnProfile && session?.user.email && (
              <div className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" />
                <span>{session.user.email}</span>
              </div>
            )}
          </div>
        </div>

        {/* Linked Accounts Modal Overlay */}
        {isAccountsOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setIsAccountsOpen(false)}
          >
            <div
              className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md p-5 space-y-4 animate-in fade-in zoom-in-95"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between pb-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <Zap className="h-5 w-5 text-primary" />
                  <h3 className="font-bold text-lg text-foreground">Linked Accounts</h3>
                  <SampleDataBadge />
                </div>
                <button
                  onClick={() => setIsAccountsOpen(false)}
                  className="text-muted-foreground hover:text-foreground text-sm font-semibold p-1"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-2.5 max-h-[60vh] overflow-y-auto">
                {LINKED_ACCOUNTS.map((acc) => (
                  <div
                    key={acc.platform}
                    className="p-3 rounded-lg border border-border bg-background flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{acc.icon}</span>
                      <div>
                        <h4 className="font-bold text-sm text-foreground">{acc.platform}</h4>
                        <p className="text-xs text-muted-foreground">{acc.username}</p>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="h-2 w-2 rounded-full bg-emerald-500" />
                          <span className="text-[11px] text-muted-foreground">{acc.status}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="pt-2 text-right">
                <Button variant="secondary" size="sm" onClick={() => setIsAccountsOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 2-Column Content Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Main Feed Column (Posts Only) */}
          <div className="lg:col-span-9 space-y-4">
            <div className="flex items-center gap-2 pb-2 border-b border-border">
              <MessageSquare className="h-4 w-4 text-foreground" />
              <h2 className="text-sm font-bold text-foreground">Posts</h2>
            </div>

            {isOwnProfile && <PostComposer />}

            <PostFeed
              authorId={profile.id}
              emptyMessage={
                isOwnProfile
                  ? "You haven't posted anything yet."
                  : `@${handle} hasn't posted anything yet.`
              }
            />
          </div>

          {/* Right Vertical Sidebar Area */}
          <div className="lg:col-span-3 space-y-4">
            {/* Featured Rank Card */}
            <div className="p-4 rounded-xl border border-border bg-card shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-foreground" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Featured Rank</span>
                </div>
                <SampleDataBadge />
              </div>
              <div>
                <h3 className="text-xl font-bold text-foreground">Radiant #420</h3>
                <p className="text-xs text-muted-foreground font-medium">Valorant Competitive</p>
              </div>
              <div className="pt-3 border-t border-border flex justify-between items-center text-xs">
                <div><span className="text-muted-foreground">Win Rate</span><p className="font-bold text-foreground">68.4%</p></div>
                <div className="text-right"><span className="text-muted-foreground">Main Agents</span><p className="font-semibold text-foreground">Jett / Reyna</p></div>
              </div>
            </div>

            {/* Favorite Games & Ranks Card */}
            <div className="p-4 rounded-xl border border-border bg-card shadow-sm">
              <div className="flex items-center justify-between mb-3 pb-2 border-b border-border">
                <div className="flex items-center gap-2">
                  <Gamepad2 className="h-4 w-4 text-foreground" />
                  <h3 className="text-sm font-bold">Favorite Games</h3>
                </div>
                <SampleDataBadge />
              </div>
              <div className="space-y-2.5">
                {FAVORITE_GAMES.map((game) => (
                  <div key={game.name} className="p-3 rounded-lg border border-border bg-background hover:bg-muted/60 transition-colors">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold text-foreground truncate">{game.name}</span>
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-medium">{game.tag}</Badge>
                    </div>
                    <p className="text-xs font-semibold text-foreground">{game.rank}</p>
                    <div className="flex justify-between items-center text-[11px] text-muted-foreground mt-1">
                      <span>{game.hours}</span><span>{game.winRate} WR</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
