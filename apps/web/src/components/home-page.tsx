import { Link } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Compass, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostComposer } from "@/components/post-composer";
import { PostFeed } from "@/components/post-feed";
import { SegmentedControl, SegmentedControlItem } from "@/components/segmented-control";
import { homeFeedScopeAtom, postFeedAtom } from "@/atoms/post-feed";
import { feedScopeAtom } from "@/lib/feed-scope";
import { m } from "@/paraglide/messages.js";

/**
 * The home feed page (route `/`): the For you|Following scope switch, the
 * composer, and the scoped feed. Signed-out visitors never get here — the
 * route is gated (see `use-require-signed-in.ts`), so the old sign-in CTA
 * branch is gone and there is deliberately no third view to reintroduce it.
 */
export function HomePage() {
  const setFeedScope = useSetAtom(feedScopeAtom);
  // `null` while the session is pending; see the comment on
  // `homeFeedScopeAtom` in atoms/post-feed.ts for why that guard now lives
  // in the atom rather than here.
  const scope = useAtomValue(homeFeedScopeAtom);

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
      <div className="border-border flex items-baseline justify-between gap-3 border-b pb-2">
        <h1 className="text-lg font-bold tracking-tight">{m.feed_title()}</h1>
        <SegmentedControl label={m.feed_label()}>
          <SegmentedControlItem active={scope === "global"} onClick={() => setFeedScope("global")}>
            {m.feed_for_you()}
          </SegmentedControlItem>
          <SegmentedControlItem
            active={scope === "following"}
            onClick={() => setFeedScope("following")}
          >
            {m.feed_following()}
          </SegmentedControlItem>
        </SegmentedControl>
      </div>

      <PostComposer />

      {/*
        `scope` is null exactly while the session is pending — see
        `homeFeedScopeAtom`. Rendering the feed straight away would mount the
        *global* one, fire a request, then flip to Following a tick later and
        fire a second. This is the same spinner PostFeed shows while loading,
        so it costs no visible state.
      */}
      {scope === null ? (
        <div className="flex justify-center py-12">
          <Loader2 className="text-primary dark:text-link h-6 w-6 animate-spin motion-reduce:animate-none" />
        </div>
      ) : (
        <PostFeed
          feedAtom={postFeedAtom({ feed: scope })}
          emptyMessage={scope === "following" ? m.feed_empty_following() : m.feed_empty()}
          emptyAction={
            scope === "following" ? (
              <Button
                size="sm"
                nativeButton={false}
                render={<Link to="/discover" className="gap-1.5" />}
              >
                <Compass className="h-4 w-4" />
                <span>{m.feed_find_people()}</span>
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
