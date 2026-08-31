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
export let client = createORPCClient<RouterClient<AppRouter>>(link);

/** TanStack Query utilities over `client` — the layer atoms build query/mutation options from. */
export let orpc = createTanstackQueryUtils(client);

/**
 * Test-only seams: swap the module's live exports for utilities built over a
 * harness's fake client. Production never calls these; consumers keep
 * importing the same names, and ESM live bindings deliver the substitution.
 */
export function installTestClient<TestClient>(testClient: TestClient): void {
  client =
    // SAFETY: test clients implement the router's procedure surface by contract;
    // the inferred oRPC client type is wider than the seam needs to express.
    testClient as typeof client;
  orpc = createTanstackQueryUtils(client);
}

export function installTestOrpc<TestOrpc>(testOrpc: TestOrpc): void {
  // SAFETY: test utils are built by createTanstackQueryUtils over a fake client
  // carrying the router's procedure names.
  orpc = testOrpc as typeof orpc;
}

/**
 * One page of `post.list` — normally a keyset-paginated slice of posts;
 * direct-reply pages additionally carry their bounded inline continuations.
 */
export type PostListPage = Awaited<ReturnType<typeof client.post.list>>;
/** A single post as served by the API, with viewer-relative like state. */
export type Post = PostListPage["items"][number];
/** The `post.thread` payload: the focused post plus its ancestor chain. */
export type Thread = Awaited<ReturnType<typeof client.post.thread>>;

/** A resolved link preview card, as `post.linkCard` returns it. */
export type LinkCard = NonNullable<Awaited<ReturnType<typeof client.post.linkCard>>["card"]>;

/** One page of `user.followers`/`user.following`. */
export type UserListPage = Awaited<ReturnType<typeof client.user.followers>>;
/** A person as served in follower/following lists, with viewer-relative follow state. */
export type UserSummary = UserListPage["items"][number];
/** A user profile as served by `user.byUsername`. */
export type Profile = Awaited<ReturnType<typeof client.user.byUsername>>;

/**
 * The `search.typeahead` payload: up to five matching profiles, plus a legacy
 * always-empty `posts` field kept for rolling-deploy compatibility.
 */
export type SearchTypeahead = Awaited<ReturnType<typeof client.search.typeahead>>;
/** One page of `search.users` — a keyset-paginated slice of user matches. */
export type SearchUsersPage = Awaited<ReturnType<typeof client.search.users>>;
/** A person as served in search results, with viewer-relative follow state. */
export type SearchUser = SearchUsersPage["items"][number];
/** One page of `search.posts` — a keyset-paginated slice of post matches. */
export type SearchPostsPage = Awaited<ReturnType<typeof client.search.posts>>;

/** One page of `moderation.queue` — unresolved report groups merged with open appeals. */
export type ModerationQueuePage = Awaited<ReturnType<typeof client.moderation.queue>>;
/** One case in the queue: reports and/or an open appeal against one target. */
export type ModerationCase = ModerationQueuePage["items"][number];
/** A moderation case detail — full report history, open appeal, moderator projection of target. */
export type ModerationCaseDetail = Awaited<ReturnType<typeof client.moderation.case>>;
/** One page of `moderation.auditLog`. */
export type AuditLogPage = Awaited<ReturnType<typeof client.moderation.auditLog>>;
/** One audit-log entry: an action plus actor and target summaries. */
export type AuditEntry = AuditLogPage["items"][number];
/** The `moderation.team` payload. */
export type ModerationTeam = Awaited<ReturnType<typeof client.moderation.team>>;
/** A person as served in the moderation team list. */
export type TeamMember = ModerationTeam["items"][number];
/** One person in the viewer's blocked list — the profile shape plus the block's timestamp. */
export type BlockedUser = Awaited<
  ReturnType<typeof client.moderation.listBlocked>
>["items"][number];

/** One page of `notification.list` — a keyset-paginated slice of the viewer's notifications. */
export type NotificationListPage = Awaited<ReturnType<typeof client.notification.list>>;
/** One notification row: its type, read state, actor summary, and the post or moderation action it references. */
export type NotificationItem = NotificationListPage["items"][number];
/** The `notification.unreadCount` payload — what the header badge renders. */
export type NotificationUnreadCount = Awaited<ReturnType<typeof client.notification.unreadCount>>;

/**
 * A handle that doesn't exist won't start existing on the second attempt, and
 * neither will one the server rejected as malformed — only retry the failures
 * that might actually be transient.
 *
 * Lives here rather than inline now that the profile route and both follower
 * list routes need the same rule.
 */
export function retryUnlessClientError(failureCount: number, error: Error): boolean {
  return (
    !(error instanceof ORPCError && error.status >= 400 && error.status < 500) && failureCount < 2
  );
}
