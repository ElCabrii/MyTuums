import { Link } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Compass, LogIn, Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostComposer } from "@/components/post-composer";
import { PostFeed } from "@/components/post-feed";
import { SegmentedControl, SegmentedControlItem } from "@/components/segmented-control";
import { isSignedInAtom } from "@/atoms/session";
import { homeFeedScopeAtom, postFeedAtom } from "@/atoms/post-feed";
import { feedScopeAtom } from "@/lib/feed-scope";

export function HomePage() {
  const setFeedScope = useSetAtom(feedScopeAtom);
  const signedIn = useAtomValue(isSignedInAtom);
  // `null` while the session is pending; see the comment on
  // `homeFeedScopeAtom` in atoms/post-feed.ts for why that guard now lives
  // in the atom rather than here.
  const scope = useAtomValue(homeFeedScopeAtom);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-4">
      <div className="flex items-baseline justify-between gap-3 pb-2 border-b border-border">
        <h1 className="text-lg font-bold tracking-tight">Home</h1>
        {signedIn ? (
          <SegmentedControl label="Feed">
            <SegmentedControlItem
              active={scope === "global"}
              onClick={() => setFeedScope("global")}
            >
              For you
            </SegmentedControlItem>
            <SegmentedControlItem
              active={scope === "following"}
              onClick={() => setFeedScope("following")}
            >
              Following
            </SegmentedControlItem>
          </SegmentedControl>
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
        `scope` is null exactly while the session is pending — see
        `homeFeedScopeAtom`. Rendering the feed straight away would mount the
        *global* one, fire a request, then flip to Following a tick later and
        fire a second. This is the same spinner PostFeed shows while loading,
        so it costs no visible state.
      */}
      {scope === null ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (
        <PostFeed
          feedAtom={postFeedAtom({ feed: scope })}
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
