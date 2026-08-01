import { createFileRoute, Link } from "@tanstack/react-router";
import { LogIn, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostComposer } from "@/components/post-composer";
import { PostFeed } from "@/components/post-feed";
import { useSession } from "@/lib/auth-client";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { data: session } = useSession();

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-4">
      <div className="flex items-baseline justify-between pb-2 border-b border-border">
        <h1 className="text-lg font-bold tracking-tight">Home</h1>
        {/* There's no follow graph yet, so "home" is everyone's posts. */}
        <span className="text-xs text-muted-foreground">Latest from everyone</span>
      </div>

      {session?.user ? (
        <PostComposer />
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Log in to post and like.</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/login" className="gap-1.5" />}>
              <LogIn className="h-4 w-4" />
              <span>Log in</span>
            </Button>
            <Button size="sm" nativeButton={false} render={<Link to="/register" className="gap-1.5" />}>
              <UserPlus className="h-4 w-4" />
              <span>Register</span>
            </Button>
          </div>
        </div>
      )}

      <PostFeed emptyMessage="No posts yet. Be the first to post something." />
    </div>
  );
}
