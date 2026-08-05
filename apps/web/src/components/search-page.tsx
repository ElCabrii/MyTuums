import { getRouteApi } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { AlertCircle, Loader2, MessageSquare, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostCard } from "@/components/post-card";
import { UserRow } from "@/components/user-list";
import { searchPostsAtom, searchUsersAtom } from "@/atoms/search";
import { m } from "@/paraglide/messages.js";

const routeApi = getRouteApi("/search");

/**
 * The `/search` results page: a heading for the query and the People and
 * Posts sections, or a "type something" prompt when the URL carries no `q`.
 */
export function SearchPage() {
  const { q } = routeApi.useSearch();

  if (!q) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
          <Search className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">{m.search_empty_query()}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      <h1 className="text-lg font-bold tracking-tight">{m.search_results_for({ query: q })}</h1>

      <SearchUsersSection q={q} />
      <SearchPostsSection q={q} />
    </div>
  );
}

/**
 * The people half of the results page — the same four states PostFeed renders
 * (spinner, retryable error, dashed empty, "Load more" rows), fed by
 * `searchUsersAtom`. The heading is hoisted because it must stay mounted in
 * every state: the `aria-labelledby` pair gives the region its accessible
 * name, so a section that swapped its heading for a spinner would lose it.
 */
function SearchUsersSection({ q }: { q: string }) {
  const feed = useAtomValue(searchUsersAtom(q));

  const heading = (
    <h2 id="search-users-heading" className="text-sm font-bold text-foreground">
      {m.search_section_users()}
    </h2>
  );

  if (feed.isPending) {
    return (
      <section aria-labelledby="search-users-heading" className="space-y-3">
        {heading}
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none text-primary" />
        </div>
      </section>
    );
  }

  if (feed.isError) {
    return (
      <section aria-labelledby="search-users-heading" className="space-y-3">
        {heading}
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p>{feed.error.message || m.feed_load_error()}</p>
            <Button variant="outline" size="sm" onClick={() => void feed.refetch()}>
              {m.common_try_again()}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  const users = feed.data.pages.flatMap((page) => page.items);

  if (users.length === 0) {
    return (
      <section aria-labelledby="search-users-heading" className="space-y-3">
        {heading}
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
          <Users className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">{m.search_no_users({ query: q })}</p>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="search-users-heading" className="space-y-3">
      {heading}
      <div className="space-y-3">
        {users.map((user) => (
          <UserRow key={user.id} user={user} />
        ))}

        {feed.hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void feed.fetchNextPage()}
              disabled={feed.isFetchingNextPage}
              className="gap-2 rounded-full"
            >
              {feed.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>{m.common_load_more()}</span>
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The posts half of the results page — the same four states PostFeed renders,
 * fed by `searchPostsAtom`. Same hoisted-heading reasoning as
 * `SearchUsersSection`: the `aria-labelledby` pair must survive every state.
 */
function SearchPostsSection({ q }: { q: string }) {
  const feed = useAtomValue(searchPostsAtom(q));

  const heading = (
    <h2 id="search-posts-heading" className="text-sm font-bold text-foreground">
      {m.search_section_posts()}
    </h2>
  );

  if (feed.isPending) {
    return (
      <section aria-labelledby="search-posts-heading" className="space-y-4">
        {heading}
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none text-primary" />
        </div>
      </section>
    );
  }

  if (feed.isError) {
    return (
      <section aria-labelledby="search-posts-heading" className="space-y-4">
        {heading}
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p>{feed.error.message || m.feed_load_error()}</p>
            <Button variant="outline" size="sm" onClick={() => void feed.refetch()}>
              {m.common_try_again()}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  const posts = feed.data.pages.flatMap((page) => page.items);

  if (posts.length === 0) {
    return (
      <section aria-labelledby="search-posts-heading" className="space-y-4">
        {heading}
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
          <MessageSquare className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">{m.search_no_posts({ query: q })}</p>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="search-posts-heading" className="space-y-4">
      {heading}
      <div className="space-y-4">
        {posts.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}

        {feed.hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void feed.fetchNextPage()}
              disabled={feed.isFetchingNextPage}
              className="gap-2 rounded-full"
            >
              {feed.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>{m.common_load_more()}</span>
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
