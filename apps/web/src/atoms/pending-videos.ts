import { atomWithMutation, atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import { protectedProductReadyAtom } from "@/atoms/query-readiness";
import { orpc, retryUnlessClientError } from "@/lib/orpc";
import type { QueryFunctionContext } from "@tanstack/react-query";

export const pendingVideosAtom = atomWithQuery((get) => {
  const queryClient = get(queryClientAtom);
  const options = orpc.video.pending.queryOptions({ input: {} });
  return {
    ...options,
    enabled: get(protectedProductReadyAtom),
    retry: retryUnlessClientError,
    refetchInterval: 5000,
    queryFn: async (context: QueryFunctionContext<typeof options.queryKey>) => {
      const previous = queryClient.getQueryData(options.queryKey);
      const pending = await options.queryFn(context);
      if (previous?.some((item) => !pending.some((next) => next.videoId === item.videoId))) {
        await Promise.all([
          // Ranked feeds pin a snapshot. Invalidation would fetch that old
          // snapshot again and make the just-published pending card disappear.
          queryClient.resetQueries({ queryKey: orpc.post.list.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.post.thread.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.notification.key() }),
        ]);
      }
      return pending;
    },
  };
});

export const cancelPendingVideoAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.video.cancel.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.video.pending.key() }),
  });
});
