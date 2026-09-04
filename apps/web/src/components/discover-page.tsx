import { Compass } from "lucide-react";
import { PostFeed } from "@/components/post-feed";
import { postFeedAtom } from "@/atoms/post-feed";
import { m } from "@/paraglide/messages.js";

/**
 * The Discover page (route `/discover`): recent top-level posts from everyone,
 * newest first — the out-of-network reading surface. It reads the same
 * `post.list` global scope as the home feed's "For you" tab (one feed atom,
 * one cache entry, so the optimistic sweeps cover it too); ranking is a later
 * concern (#305). Deliberately no composer and no scope tabs — the header's
 * post button is where writing happens.
 *
 * Reachable only signed in: the session gate plus the server page gate (the
 * path is absent from `SIGNED_OUT_PATHS`).
 */
export function DiscoverPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
      <div className="border-border flex items-baseline justify-between gap-3 border-b pb-2">
        <h1 className="text-lg font-bold tracking-tight">{m.nav_discover()}</h1>
      </div>

      <PostFeed
        feedAtom={postFeedAtom({ feed: "global" })}
        emptyMessage={m.discover_empty()}
        emptyIcon={Compass}
      />
    </div>
  );
}
