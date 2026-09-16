/**
 * The real-time seam for private messages (issue #408): the thin, best-effort
 * event channel that tells a connected client "something changed — refetch".
 *
 * This package never owns a Durable Object binding (it has no env access —
 * see `distributed-rate-limit.ts` for the same reasoning), so the HTTP
 * entrypoint injects an adapter shaped like `MessageNotifier` through
 * `ApiServices`. The adapter reaches the per-user `MessageHub` Durable Object
 * in apps/server; tests inject a recorder or nothing at all.
 *
 * Events carry ids only, never message text or another user's private state:
 * the payload behind an event always comes back from a D1-backed procedure.
 * A missed or failed push loses nothing — D1 is the single source of truth,
 * and clients refetch on reconnect and focus.
 */

/** What changed, and where — thin enough to route an invalidation. */
export type MessagePushEvent =
  | { kind: "message"; conversationId: string }
  | { kind: "read"; conversationId: string }
  | { kind: "conversation"; conversationId: string }
  | { kind: "unread" };

/**
 * Publishes `event` to `userId`'s live connections. Implementations must
 * never throw for a healthy caller — a push is an optimization, not a
 * delivery guarantee — but the seam stays `Promise<void>` so an adapter can
 * await its fan-out when it wants backpressure.
 */
export interface MessageNotifier {
  notify(userId: string, event: MessagePushEvent): Promise<void>;
}

/**
 * The adapter the HTTP entrypoint builds over the `MessageHub` namespace.
 * Structural on purpose, exactly like `createDistributedRateLimiter`: this
 * package must compile without Cloudflare's runtime types.
 */
export function createMessageNotifier(hubs: {
  getByName(name: string): { publish(event: MessagePushEvent): Promise<void> };
}): MessageNotifier {
  return {
    async notify(userId, event) {
      // Unlike the rate-limit counters, the DO name is the user id itself,
      // per the design in issue #408: one hub instance per user. The name is
      // never exposed cross-user and carries no secret.
      await hubs.getByName(userId).publish(event);
    },
  };
}

/**
 * The post-commit half every mutating message procedure ends with. A refused
 * or absent notifier must never fail (or roll back) a committed mutation,
 * and never turn a successful send into an error response.
 */
export async function publishMessageEvent(
  notifier: MessageNotifier | null,
  userId: string,
  event: MessagePushEvent,
): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.notify(userId, event);
  } catch {
    // D1 already committed the truth; the next refetch reconciles.
  }
}
