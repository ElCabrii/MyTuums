import type { ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, MessageSquare, RefreshCw } from "lucide-react";
import { postFeedAtom, postFeedKey, refreshRankedFeedAtomFamily } from "@/atoms/post-feed";
import { PostFeed } from "@/components/post-feed";
import { GamesPrompt, WhoToFollow } from "@/components/who-to-follow";
import { Button } from "@/components/ui/button";
import { getFeedRanking, isSnapshotExpiredError } from "@/lib/ranking";
import { m } from "@/paraglide/messages.js";

/**
 * A ranked feed (issue #305): the explicit Refresh control, the optional
 * Who-to-Follow module, the cold-start games prompt, and the shared post
 * list.
 *
 * The order is fixed per browsing snapshot — focus and mutation refetches
 * hydrate the same snapshot in place — and only Refresh starts a new
 * sequence: it resets exactly this feed's query (cancelling the in-flight
 * fetch, whose late resolution the retryer discards) and the still-mounted
 * observer restarts on the same key. The skeleton between reset and first
 * page is the intentional explicit-refresh affordance.
 *
 * Snapshot expiry renders its own recovery card, never the ordinary retry:
 * retrying would resend the same expired snapshot and loop the same refusal
 * forever. Every other error keeps the ordinary path untouched (including
 * auth errors, which must never render retained rows).
 */
export function RankedFeed({
  params,
  emptyMessage,
  emptyAction,
  emptyIcon = MessageSquare,
  showParentContext = false,
  suggestions = "none",
  coldStartPrompt = true,
}: {
  /** The feed's params — ranked for the home and Discover scopes (see `postFeedAtom`). */
  params: Parameters<typeof postFeedAtom>[0];
  emptyMessage: string;
  /** Rendered under `emptyMessage` — e.g. a "find people to follow" CTA. */
  emptyAction?: ReactNode;
  /** The empty state's icon. */
  emptyIcon?: typeof MessageSquare;
  /** Render the immediate-parent preview used by profile activity cards. */
  showParentContext?: boolean;
  /** `"discover"` renders Who-to-Follow above the posts; home feeds carry none. */
  suggestions?: "none" | "discover";
  /**
   * Whether the cold-start games prompt may render. The Following feed opts
   * out — its empty state is a catch-up explanation, not an interests nudge.
   */
  coldStartPrompt?: boolean;
}) {
  const feedAtom = postFeedAtom(params);
  const feed = useAtomValue(feedAtom);
  const refresh = useSetAtom(refreshRankedFeedAtomFamily(postFeedKey(params)));
  const ranking = getFeedRanking(feed.data?.pages);
  const expired = feed.isError && isSnapshotExpiredError(feed.error);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {/* Deliberately not disabled while fetching: React Query de-dupes a
            refetch that is already in flight, so the only thing disabling
            would add is a greyed-out control failing contrast at the exact
            moment the spinner says something is happening. */}
        <Button variant="ghost" size="sm" onClick={() => refresh()}>
          <RefreshCw className={feed.isFetching ? "animate-spin motion-reduce:animate-none" : ""} />
          {m.feed_refresh()}
        </Button>
      </div>

      {suggestions === "discover" && <WhoToFollow feedAtom={feedAtom} />}

      {coldStartPrompt && ranking && !ranking.hasInterests && <GamesPrompt />}

      {expired ? (
        <div
          role="alert"
          className="border-destructive/20 bg-destructive/10 text-destructive flex items-start gap-3 rounded-xl border p-4 text-sm"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="space-y-2">
            <p>{m.feed_snapshot_expired()}</p>
            <Button variant="outline" size="sm" onClick={() => refresh()}>
              {m.feed_refresh()}
            </Button>
          </div>
        </div>
      ) : (
        <PostFeed
          feedAtom={feedAtom}
          emptyMessage={emptyMessage}
          emptyAction={emptyAction}
          emptyIcon={emptyIcon}
          showParentContext={showParentContext}
        />
      )}
    </div>
  );
}
