import { createFileRoute, Link } from "@tanstack/react-router";
import { Compass, LogIn, Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostComposer } from "@/components/post-composer";
import { PostFeed } from "@/components/post-feed";
import { SegmentedNav, SegmentedNavItem } from "@/components/segmented-nav";
import { useSession } from "@/lib/auth-client";

export type FeedScope = "following" | "global";

export const Route = createFileRoute("/")({
  // Hand-written rather than a schema library: `zod` is not a dependency of
  // apps/web, and pulling one into the browser bundle to validate a two-value
  // enum isn't a trade worth making.
  //
  // Anything unrecognised collapses to `{}` rather than throwing — a stale or
  // hand-typed `?feed=garbage` should quietly fall back to the default, not
  // break the home page. Returning `{}` (rather than an explicit default) also
  // keeps the param out of the URL when it isn't doing anything.
  validateSearch: (search: Record<string, unknown>): { feed?: FeedScope } =>
    search.feed === "following" || search.feed === "global" ? { feed: search.feed } : {},
  component: HomePage,
});

/** Exported for ./home.test.tsx. */
export function HomePage() {
  const { feed } = Route.useSearch();
  const { data: session, isPending: isSessionPending } = useSession();
  const signedIn = Boolean(session?.user);

  // Signed out is always Global: the server rejects an anonymous Following
  // request, so honouring `?feed=following` here would render an error card
  // instead of a usable page. The param is ignored rather than stripped, so a
  // shared link resolves to Following once the visitor signs in.
  const scope: FeedScope = signedIn ? (feed ?? "following") : "global";

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-4">
      <div className="flex items-baseline justify-between gap-3 pb-2 border-b border-border">
        <h1 className="text-lg font-bold tracking-tight">Home</h1>
        {signedIn ? (
          <SegmentedNav label="Feed">
            <SegmentedNavItem
              active={scope === "following"}
              render={<Link to="/" search={{ feed: "following" }} />}
            >
              Following
            </SegmentedNavItem>
            <SegmentedNavItem
              active={scope === "global"}
              render={<Link to="/" search={{ feed: "global" }} />}
            >
              Global
            </SegmentedNavItem>
          </SegmentedNav>
        ) : (
          <span className="text-xs text-muted-foreground">Latest from everyone</span>
        )}
      </div>

      {signedIn ? (
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

      {/*
        `useSession` starts pending with `data: null`, so rendering the feed
        straight away would mount the *global* one, fire a request, then flip
        to Following a tick later and fire a second. The spinner is the same
        one PostFeed shows while loading, so this costs no visible state.
      */}
      {isSessionPending ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (
        <PostFeed
          feed={scope}
          emptyMessage={
            scope === "following"
              ? "Nothing here yet — you're not following anyone who's posted."
              : "No posts yet. Be the first to post something."
          }
          emptyAction={
            scope === "following" ? (
              <Button size="sm" nativeButton={false} render={<Link to="/discover" className="gap-1.5" />}>
                <Compass className="h-4 w-4" />
                <span>Find people to follow</span>
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
