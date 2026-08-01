import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@my-tuums/api";

// In dev, Vite proxies /rpc -> http://localhost:3001/rpc
// In prod, configure this to your deployed server URL.
//
// This must be absolute: RPCLink calls `new URL(url)` with no base, so a bare
// "/rpc" throws "Failed to construct 'URL': Invalid URL" on every request.
// It's resolved lazily against the current origin so the module stays safe to
// import outside the browser (tests, tooling) where `location` is undefined.
const link = new RPCLink({
  url: () => new URL("/rpc", window.location.origin).toString(),
});

export const client = createORPCClient<RouterClient<AppRouter>>(link);

export const orpc = createTanstackQueryUtils(client);

export type PostListPage = Awaited<ReturnType<typeof client.post.list>>;
export type Post = PostListPage["items"][number];
export type Thread = Awaited<ReturnType<typeof client.post.thread>>;

export type UserListPage = Awaited<ReturnType<typeof client.user.followers>>;
export type UserSummary = UserListPage["items"][number];
export type Profile = Awaited<ReturnType<typeof client.user.byUsername>>;

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
