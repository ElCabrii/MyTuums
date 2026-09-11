import { Link } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostComposer } from "@/components/post-composer";
import { FeedSkeleton } from "@/components/post-feed";
import { RankedFeed } from "@/components/ranked-feed";
import { WhoToFollow } from "@/components/who-to-follow";
import { SegmentedControl, SegmentedControlItem } from "@/components/segmented-control";
import { homeFeedScopeAtom, postFeedAtom } from "@/atoms/post-feed";
import { feedScopeAtom } from "@/lib/feed-scope";
import { m } from "@/paraglide/messages.js";

/**
 * The home feed page (route `/`): the For you|Following scope switch, the
 * composer, and the scoped ranked feed (issue #305), with a sidebar (lg and
 * up) carrying the Who-to-Follow module and the legal links. Both scopes
 * rank — there is deliberately no chronological toggle — and the order holds
 * per browsing snapshot until an explicit Refresh starts a new one.
 * Signed-out visitors never get here — the route is gated (see
 * `use-require-signed-in.ts`), so the old sign-in CTA branch is gone and
 * there is deliberately no third view to reintroduce it.
 */
export function HomePage() {
  const setFeedScope = useSetAtom(feedScopeAtom);
  // `null` while the session is pending; see the comment on
  // `homeFeedScopeAtom` in atoms/post-feed.ts for why that guard now lives
  // in the atom rather than here.
  const scope = useAtomValue(homeFeedScopeAtom);

  return (
    <div className="mx-auto flex w-full max-w-5xl items-start gap-6 px-4 py-8">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <div className="border-border flex items-baseline justify-between gap-3 border-b pb-2">
          <h1 className="text-lg font-bold tracking-tight">{m.feed_title()}</h1>
          <SegmentedControl label={m.feed_label()}>
            <SegmentedControlItem
              active={scope === "global"}
              onClick={() => setFeedScope("global")}
            >
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
        fire a second. This is the same skeleton PostFeed shows while loading,
        so it costs no visible state.
      */}
        {scope === null ? (
          <FeedSkeleton />
        ) : (
          <RankedFeed
            params={{ feed: scope, ranked: true }}
            emptyMessage={scope === "following" ? m.feed_empty_following() : m.feed_empty()}
            // The Following feed keeps its catch-up explanation — no interests
            // nudge; For you shares Discover's cold-start prompt.
            coldStartPrompt={scope !== "following"}
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

      {/*
        The right rail (lg and up). Who-to-Follow mounts only on For you: it
        reads the same global-feed atom the feed column reads — structurally
        one observer — while mounting it on Following would fetch a second,
        unwatched feed. Following's own suggestions are empty by contract, so
        there is nothing to lose: the sidebar keeps the legal links alone.
      */}
      <aside className="hidden w-80 shrink-0 space-y-6 lg:block">
        {scope === "global" && (
          <WhoToFollow feedAtom={postFeedAtom({ feed: "global", ranked: true })} />
        )}
        <LegalLinks />
      </aside>
    </div>
  );
}

/**
 * The Home sidebar's legal links — the same three documents the site footer
 * carries (`./footer.tsx`), surfaced beside the feed. Static, no state; the
 * copy keys are the footer's so the two surfaces cannot drift.
 */
function LegalLinks() {
  return (
    <section aria-label={m.legal_links_title()} className="space-y-3">
      <h2 className="text-foreground text-sm font-bold">{m.legal_links_title()}</h2>
      <ul className="text-muted-foreground space-y-2 text-sm">
        <li>
          <Link to="/privacy" className="hover:text-foreground hover:underline">
            {m.legal_privacy_policy()}
          </Link>
        </li>
        <li>
          <Link to="/terms" className="hover:text-foreground hover:underline">
            {m.legal_terms_of_service()}
          </Link>
        </li>
        <li>
          <Link to="/mentions-legales" className="hover:text-foreground hover:underline">
            {m.legal_notice()}
          </Link>
        </li>
      </ul>
    </section>
  );
}
