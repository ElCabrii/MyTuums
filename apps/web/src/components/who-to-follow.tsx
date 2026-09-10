import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import type { postFeedAtom } from "@/atoms/post-feed";
import { UserRow } from "@/components/user-list";
import { getFeedRanking } from "@/lib/ranking";
import { m } from "@/paraglide/messages.js";

/**
 * Who to Follow (issue #305): the compact suggestion module above Discover's
 * posts. Reads the ranked Discover feed's own metadata — the same atom the
 * post list reads, so there is structurally one observer, not two that
 * happen to agree — and renders the top three candidates the API returned.
 *
 * Follow state is live: `lib/follow-cache.ts` patches suggestion rows in
 * place, so a successful follow filters its row out here without shuffling
 * the post feed, and the next explicit Refresh refills from the new
 * snapshot. No persistent dismissal, no pagination — a removed row stays
 * gone until the next ranking, which is the whole contract.
 *
 * Nothing renders while the feed loads or errors (the post list's skeleton
 * and retry own those states), and nothing renders once every candidate is
 * followed or requested. The cold-start games prompt lives in
 * `RankedFeed`, not here, so Discover never renders it twice.
 */
export function WhoToFollow({ feedAtom }: { feedAtom: ReturnType<typeof postFeedAtom> }) {
  const feed = useAtomValue(feedAtom);
  const ranking = getFeedRanking(feed.data?.pages);
  if (!ranking) return null;

  const visible = ranking.suggestions
    .filter((item) => !item.viewerIsFollowing && !item.hasRequested)
    .slice(0, 3);

  if (visible.length === 0) return null;

  return (
    <section aria-label={m.who_to_follow_title()} className="space-y-3">
      <h2 className="text-foreground text-sm font-bold">{m.who_to_follow_title()}</h2>
      <div className="space-y-3">
        {visible.map((item) => (
          <UserRow key={item.id} user={item} />
        ))}
      </div>
    </section>
  );
}

/**
 * Cold-start nudge: favorite games sharpen the ranking. Advisory only —
 * never a gate. Rendered once per ranked surface by `RankedFeed` (never by
 * `WhoToFollow`, so Discover shows exactly one copy).
 */
export function GamesPrompt() {
  return (
    <p className="text-muted-foreground text-sm">
      {m.who_to_follow_games_prompt()}{" "}
      <Link
        to="/games"
        className="text-link hover:text-link/80 font-medium underline underline-offset-2"
      >
        {m.who_to_follow_games_link()}
      </Link>
    </p>
  );
}
