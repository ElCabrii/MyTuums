import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { orpc } from "@/lib/orpc";
import { protectedProductReadyAtom } from "@/atoms/query-readiness";
import { messagesUnreadQueryOptions } from "@/lib/query-definitions";

/**
 * The real-time half of private messages (issue #408): one EventSource for
 * the whole app, opened only once the protected product is ready (session +
 * consent + onboarding — everything `/events/messages` authorizes) and
 * closed on unmount, which sign-out and the auth gates guarantee by
 * unmounting the signed-in tree.
 *
 * Events are thin invalidation notices carrying ids only. Each one
 * invalidates the cheapest set of keys that cannot be patched from an id:
 * the affected thread (any loaded page), the inbox, the requests feed, and
 * the counts. D1 stays the source of truth — a missed push loses nothing.
 *
 * `onopen` is the recovery path, not a formality: it fires on the INITIAL
 * connection (closing the race between the first fetches and the first
 * events) and on every RECONNECT (EventSource retries per the server's
 * `retry:` hint after a dropped stream, a deploy, or the hub's stream
 * lifetime bound). Both moments refresh everything that could have changed
 * while no stream was connected. Focus refetch — the QueryClient default —
 * covers the in-between gaps the same way it always has.
 */
export function useMessageEvents(): void {
  const ready = useAtomValue(protectedProductReadyAtom);
  const queryClient = useAtomValue(queryClientAtom);

  useEffect(() => {
    if (!ready) return;
    const source = new EventSource("/events/messages");

    const refreshLists = () => {
      void queryClient.invalidateQueries({ queryKey: orpc.message.conversations.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.message.requests.key() });
      void queryClient.invalidateQueries({ queryKey: messagesUnreadQueryOptions().queryKey });
      void queryClient.invalidateQueries({ queryKey: orpc.message.thread.key() });
    };

    source.onopen = refreshLists;
    // The hub names every frame (`event: message|read|conversation|unread`);
    // each kind invalidates the same bounded key set, so one handler serves
    // all four — the payloads are ids, never patchable state.
    for (const kind of ["message", "read", "conversation", "unread"] as const) {
      source.addEventListener(kind, refreshLists);
    }

    return () => source.close();
  }, [ready, queryClient]);
}
