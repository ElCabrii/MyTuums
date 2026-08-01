import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { orpc } from "@/lib/orpc";
import { store } from "@/lib/store";

/**
 * A half-typed reply, per parent post.
 *
 * Deliberately in-memory, unlike `composerDraftAtom` in `atoms/composer.ts`
 * which persists to `localStorage`. That one is a single draft under a single
 * key, so it can be written unconditionally and read back forever. A *family*
 * of persisted drafts is a different proposition: it would accumulate one
 * storage key per post the viewer ever started replying to, with nothing in
 * the app that could ever evict them — `localStorage` has no TTL and the app
 * has no list of which keys it once wrote. Keeping these in memory bounds
 * them by the session instead.
 */
export const replyDraftAtomFamily = atomFamily<string, PrimitiveAtom<string>>(() => atom(""));

/**
 * `post.create` scoped to one parent. Like `createPostAtom` this has no
 * `scope` and no optimistic patch — there is no existing row to flip, and a
 * synthesised reply would need a server-assigned id and a position in a
 * keyset-ordered list to be spliced correctly.
 *
 * `onSuccess` reaches the store directly rather than closing over a `set`,
 * for the same reason `createPostAtom` does: `atomWithMutation`'s options
 * factory is handed a `Getter` only.
 */
export const createReplyAtomFamily = atomFamily((parentId: string) =>
  atomWithMutation((get) => {
    const queryClient = get(queryClientAtom);

    return orpc.post.create.mutationOptions({
      onSuccess: async () => {
        store.set(replyDraftAtomFamily(parentId), "");

        // Two prefixes, because a reply lands in two different caches:
        //
        // - `post.list` holds the reply list under this parent, and the
        //   author's profile feed (which opts into replies).
        // - `post.thread` holds the parent's own `replyCount`, and the same
        //   count on every ancestor above it if this reply is itself nested.
        //
        // Invalidate rather than splice, for the same reason as
        // `createPostAtom`: where the new row belongs is server-ordered, and
        // guessing means guessing a cursor position.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.post.list.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.post.thread.key() }),
        ]);
      },
    });
  }),
);

/** Drops every entry these families have created. See `clearPostFeedFamily`. */
export function clearReplyFamilies(): void {
  for (const key of [...replyDraftAtomFamily.getParams()]) replyDraftAtomFamily.remove(key);
  for (const key of [...createReplyAtomFamily.getParams()]) createReplyAtomFamily.remove(key);
}
