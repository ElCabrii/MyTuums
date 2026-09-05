import type { ReactNode } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Gamepad2, MessageSquare, Search, Users } from "lucide-react";
import { GameCover } from "@/components/game-cover";
import { PostCard } from "@/components/post-card";
import { FeedSkeleton } from "@/components/post-feed";
import { PaginatedState, type PaginatedStateQuery } from "@/components/paginated-state";
import { Skeleton } from "@/components/ui/skeleton";
import { UserRow, UserListSkeleton } from "@/components/user-list";
import { mergedGameMentions } from "@/lib/game-mentions";
import { gameListAtom } from "@/atoms/games";
import { searchPostsAtom, searchUsersAtom } from "@/atoms/search";
import { m } from "@/paraglide/messages.js";

const routeApi = getRouteApi("/search");

/**
 * The `/search` results page: a heading for the query and the People and
 * Posts sections, or a "type something" prompt when the URL carries no `q`.
 *
 * The results body is a child component (`SearchResultsBody`) rather than
 * inline JSX so that no hook in this file is conditional: `SearchPage`
 * itself calls exactly one hook (`useSearch`), and the data hooks run in the
 * body, which mounts only when `q` exists. The alternative — hoisting both
 * `useAtomValue`s above the guard — would call the search families with an
 * undefined key on the prompt render, and worse, issue #49 was precisely a
 * hook-count change (`/search` → `/search?q=...` re-renders this component
 * without remounting it) and this keeps the count stable on every path.
 */
export function SearchPage() {
  const { q } = routeApi.useSearch();
  // The production route validator already canonicalises `q`, but keeping the
  // rendering boundary defensive prevents a whitespace-only value from
  // mounting disabled infinite queries in a perpetual pending state.
  const query = q?.trim();

  if (!query) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
        {/* A real h1 on every page state — the prompt state included, which
            Lighthouse's heading audit sees before any query is typed. The
            input's aria label is the page's own name for "Search". */}
        <h1 className="text-lg font-bold tracking-tight">{m.search_input_aria()}</h1>
        <div className="border-border bg-card/40 rounded-xl border border-dashed p-10 text-center">
          <Search className="text-muted-foreground/60 mx-auto mb-3 h-8 w-8" />
          <p className="text-muted-foreground text-sm">{m.search_empty_query()}</p>
        </div>
      </div>
    );
  }

  return <SearchResultsBody q={query} />;
}

/**
 * The results half of `/search`, mounted only once the URL carries a `q` —
 * the same split as `CaseBody` in the moderation desk, for the same reason:
 * its hooks are unconditional while the parent's early return is in play.
 */
function SearchResultsBody({ q }: { q: string }) {
  const usersFeed = useAtomValue(searchUsersAtom(q));
  const gamesFeed = useAtomValue(gameListAtom({ sort: "popularity", q }));
  const postsFeed = useAtomValue(searchPostsAtom(q));
  const gameMentions = mergedGameMentions(postsFeed.data?.pages ?? []);

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-8">
      <h1 className="text-lg font-bold tracking-tight">{m.search_results_for({ query: q })}</h1>

      <SearchResultsSection
        feed={usersFeed}
        headingId="search-users-heading"
        headingLabel={m.search_section_users()}
        emptyIcon={Users}
        emptyMessage={m.search_no_users({ query: q })}
        listClassName="space-y-3"
        loadingFallback={<UserListSkeleton />}
        renderItem={(user) => <UserRow key={user.id} user={user} />}
      />
      <SearchResultsSection
        feed={gamesFeed}
        headingId="search-games-heading"
        headingLabel={m.search_section_games()}
        emptyIcon={Gamepad2}
        emptyMessage={m.search_no_games({ query: q })}
        listClassName="space-y-3"
        loadingFallback={<SearchGameRowSkeleton />}
        renderItem={(game) => (
          <GameResultRow
            key={game.igdbId}
            slug={game.slug}
            name={game.name}
            cover={game.coverMediaPath}
            year={game.firstReleaseYear}
          />
        )}
      />
      <SearchResultsSection
        feed={postsFeed}
        headingId="search-posts-heading"
        headingLabel={m.search_section_posts()}
        emptyIcon={MessageSquare}
        emptyMessage={m.search_no_posts({ query: q })}
        listClassName="space-y-4"
        loadingFallback={<FeedSkeleton />}
        renderItem={(post) => <PostCard key={post.id} post={post} gameMentions={gameMentions} />}
      />
    </div>
  );
}

/** One game hit: cover thumb, name, year — the directory's card, row-shaped. */
function GameResultRow({
  slug,
  name,
  cover,
  year,
}: {
  slug: string;
  name: string;
  cover: string | null;
  year: number | null;
}) {
  return (
    <Link
      to="/games/$slug"
      params={{ slug }}
      className="focus-visible:ring-ring flex items-center gap-3 rounded-lg px-2 py-1.5 focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="bg-muted h-14 w-10 shrink-0 overflow-hidden rounded-md">
        <GameCover cover={cover} name={name} sizes="56px" />
      </div>
      <span className="min-w-0">
        <span className="text-foreground block truncate text-sm font-medium">{name}</span>
        {year !== null && <span className="text-muted-foreground block text-xs">{year}</span>}
      </span>
    </Link>
  );
}

/**
 * Three placeholder rows that mirror `GameResultRow` (cover thumb + name +
 * year) while game search loads.
 *
 * `aria-hidden`: it paints structure, not information.
 */
function SearchGameRowSkeleton() {
  return (
    <div className="space-y-1" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 px-2 py-1.5">
          <Skeleton className="h-14 w-10 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The data-shaped half of a results section — the same four states the shared
 * `PaginatedState` renders (spinner, retryable error, dashed empty, "Load
 * more" rows), fed by either the users or the posts atom. The heading is
 * hoisted because it must stay mounted in every state: the `aria-labelledby`
 * pair gives the region its accessible name, so a section that swapped its
 * heading for a spinner would lose it.
 */
function SearchResultsSection<T>({
  feed,
  headingId,
  headingLabel,
  emptyIcon,
  emptyMessage,
  listClassName,
  loadingFallback,
  renderItem,
}: {
  feed: PaginatedStateQuery & { data?: { pages: Array<{ items: T[] }> } };
  headingId: string;
  headingLabel: string;
  emptyIcon: typeof Users;
  emptyMessage: string;
  listClassName: string;
  loadingFallback?: ReactNode;
  renderItem: (item: T) => ReactNode;
}) {
  const items = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby={headingId} className={listClassName}>
      <h2 id={headingId} className="text-foreground text-sm font-bold">
        {headingLabel}
      </h2>
      <PaginatedState
        query={feed}
        errorMessage={m.feed_load_error()}
        emptyIcon={emptyIcon}
        emptyMessage={emptyMessage}
        isEmpty={items.length === 0}
        listClassName={listClassName}
        loadingFallback={loadingFallback}
      >
        {items.map(renderItem)}
      </PaginatedState>
    </section>
  );
}
