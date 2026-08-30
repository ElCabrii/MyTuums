import { Bookmark } from "lucide-react";
import { PostFeed } from "@/components/post-feed";
import { postFeedAtom } from "@/atoms/post-feed";
import { m } from "@/paraglide/messages.js";

/**
 * The bookmarks page (route `/bookmarks`): the caller's private saved posts,
 * newest save first. The feed itself is a `post.list` scope (`feed:
 * "bookmarks"`), so it shares the feed atom family — and therefore the
 * optimistic like/delete sweeps — with every other post surface.
 *
 * Private by construction: the page renders only the viewer's own rows and is
 * reachable only signed in (the session gate plus the server page gate — the
 * path is absent from `SIGNED_OUT_PATHS`).
 */
export function BookmarksPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
      <div className="border-border flex items-baseline justify-between gap-3 border-b pb-2">
        <h1 className="text-lg font-bold tracking-tight">{m.bookmarks_title()}</h1>
      </div>

      <PostFeed
        feedAtom={postFeedAtom({ feed: "bookmarks" })}
        emptyMessage={m.bookmarks_empty()}
        emptyIcon={Bookmark}
        // A saved reply keeps its "Replying to …" line, the same as a profile
        // activity card: without it a reply saved out of its thread has no
        // context at all.
        showParentContext
      />
    </div>
  );
}
