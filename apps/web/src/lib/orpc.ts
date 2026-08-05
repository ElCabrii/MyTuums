import { createORPCClient, ORPCError } from "@orpc/client";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@my-tuums/api";

// In dev, Vite proxies /rpc -> http://localhost:3001/rpc; in prod the server
// serves the built SPA from the same origin, so `window.location.origin` is
// the API origin in both cases.
//
// This must be absolute: RPCLink calls `new URL(url)` with no base, so a bare
// "/rpc" throws "Failed to construct 'URL': Invalid URL" on every request.
// It's resolved lazily against the current origin so the module stays safe to
// import outside the browser (tests, tooling) where `location` is undefined.
const link = new RPCLink({
  url: () => new URL("/rpc", window.location.origin).toString(),
  // The mirror of the server's `SimpleCsrfProtectionHandlerPlugin` (see
  // apps/server/src/index.ts): adds the `x-csrf-token` header the server
  // requires, which a cross-origin `<form>` cannot send. The two defaults
  // agree on the header name and value; if one side is configured, the
  // other must be reconfigured to match.
  plugins: [new SimpleCsrfProtectionLinkPlugin()],
});

/** The raw oRPC client, for direct procedure calls outside the query layer. */
export const client = createORPCClient<RouterClient<AppRouter>>(link);

/** TanStack Query utilities over `client` — the layer atoms build query/mutation options from. */
export const orpc = createTanstackQueryUtils(client);

/** One page of `post.list` — a keyset-paginated slice of posts. */
export type PostListPage = Awaited<ReturnType<typeof client.post.list>>;
/** A single post as served by the API, with viewer-relative like state. */
export type Post = PostListPage["items"][number];
/** The `post.thread` payload: the focused post plus its ancestor chain. */
export type Thread = Awaited<ReturnType<typeof client.post.thread>>;

/** One page of `user.followers`/`user.following`. */
export type UserListPage = Awaited<ReturnType<typeof client.user.followers>>;
/** A person as served in follower/following lists, with viewer-relative follow state. */
export type UserSummary = UserListPage["items"][number];
/** A user profile as served by `user.byUsername`. */
export type Profile = Awaited<ReturnType<typeof client.user.byUsername>>;

/** The `search.typeahead` payload: up to five user and five post matches. */
export type SearchTypeahead = Awaited<ReturnType<typeof client.search.typeahead>>;
/** One page of `search.users` — a keyset-paginated slice of user matches. */
export type SearchUsersPage = Awaited<ReturnType<typeof client.search.users>>;
/** A person as served in search results, with viewer-relative follow state. */
export type SearchUser = SearchUsersPage["items"][number];
/** One page of `search.posts` — a keyset-paginated slice of post matches. */
export type SearchPostsPage = Awaited<ReturnType<typeof client.search.posts>>;

/**
 * A handle that doesn't exist won't start existing on the second attempt, and
 * neither will one the server rejected as malformed — only retry the failures
 * that might actually be transient.
 *
 * Lives here rather than inline now that the profile route and both follower
 * list routes need the same rule.
 */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  return (
    !(error instanceof ORPCError && error.status >= 400 && error.status < 500) && failureCount < 2
  );
}
