import type { ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { MessageSquare, Search, Users } from "lucide-react";
import { PostCard } from "@/components/post-card";
import { PaginatedState, type PaginatedStateQuery } from "@/components/paginated-state";
import { UserRow } from "@/components/user-list";
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

  if (!q) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="border-border bg-card/40 rounded-xl border border-dashed p-10 text-center">
          <Search className="text-muted-foreground/60 mx-auto mb-3 h-8 w-8" />
          <p className="text-muted-foreground text-sm">{m.search_empty_query()}</p>
        </div>
      </div>
    );
  }

  return <SearchResultsBody q={q} />;
}

/**
 * The results half of `/search`, mounted only once the URL carries a `q` —
 * the same split as `CaseBody` in the moderation desk, for the same reason:
 * its hooks are unconditional while the parent's early return is in play.
 */
function SearchResultsBody({ q }: { q: string }) {
  const usersFeed = useAtomValue(searchUsersAtom(q));
  const postsFeed = useAtomValue(searchPostsAtom(q));

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
        renderItem={(user) => <UserRow key={user.id} user={user} />}
      />
      <SearchResultsSection
        feed={postsFeed}
        headingId="search-posts-heading"
        headingLabel={m.search_section_posts()}
        emptyIcon={MessageSquare}
        emptyMessage={m.search_no_posts({ query: q })}
        listClassName="space-y-4"
        renderItem={(post) => <PostCard key={post.id} post={post} />}
      />
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
  renderItem,
}: {
  feed: PaginatedStateQuery & { data?: { pages: Array<{ items: T[] }> } };
  headingId: string;
  headingLabel: string;
  emptyIcon: typeof Users;
  emptyMessage: string;
  listClassName: string;
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
      >
        {items.map(renderItem)}
      </PaginatedState>
    </section>
  );
}
