import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { waitFor } from "@testing-library/react";

const { fakeClient } = vi.hoisted(() => ({
  fakeClient: { post: { create: vi.fn(), list: vi.fn(), thread: vi.fn() } },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { orpc: createTanstackQueryUtils(fakeClient) };
});

import { orpc } from "@/lib/orpc";
import {
  clearReplyFamilies,
  createReplyAtomFamily,
  replyDraftAtomFamily,
} from "@/atoms/reply-composer";
// Same reasoning as composer.test.ts: `onSuccess` reaches the app's ONE
// singleton store directly (it can't be handed a `set`), so that's the only
// store the draft-clearing side effect is observable on.
import { store as singletonStore } from "@/lib/store";
import { queryClient as singletonQueryClient } from "@/lib/query-client";

beforeEach(() => {
  fakeClient.post.create.mockReset();
});

afterEach(() => {
  singletonQueryClient.clear();
  vi.restoreAllMocks();
});

describe("replyDraftAtomFamily", () => {
  // A family of persisted drafts would accumulate one localStorage key per
  // post ever replied to, with nothing in the app able to evict them — see
  // the comment in the source. In-memory only is the whole point.
  it("is in-memory only — nothing is written to localStorage", () => {
    const store = createStore();
    store.set(replyDraftAtomFamily("parent-1"), "a half-typed reply");

    expect(store.get(replyDraftAtomFamily("parent-1"))).toBe("a half-typed reply");
    expect(localStorage.length).toBe(0);
  });

  it("is keyed per parent post", () => {
    const store = createStore();
    store.set(replyDraftAtomFamily("parent-1"), "reply to one");
    store.set(replyDraftAtomFamily("parent-2"), "reply to another");

    expect(store.get(replyDraftAtomFamily("parent-1"))).toBe("reply to one");
    expect(store.get(replyDraftAtomFamily("parent-2"))).toBe("reply to another");
  });
});

describe("createReplyAtomFamily", () => {
  it("tracks pending state, clears the draft, and invalidates post.list + post.thread on success", async () => {
    singletonStore.set(replyDraftAtomFamily("parent-1"), "a reply");
    const invalidateSpy = vi.spyOn(singletonQueryClient, "invalidateQueries");

    let resolveCreate!: (value: unknown) => void;
    fakeClient.post.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const mutationAtom = createReplyAtomFamily("parent-1");
    const unsub = singletonStore.sub(mutationAtom, () => {});
    singletonStore.get(mutationAtom).mutate({ content: "a reply", parentId: "parent-1" });

    await waitFor(() => expect(singletonStore.get(mutationAtom).isPending).toBe(true));

    resolveCreate({ id: "reply-1" });

    await waitFor(() => expect(singletonStore.get(mutationAtom).isSuccess).toBe(true));

    expect(singletonStore.get(replyDraftAtomFamily("parent-1"))).toBe("");
    // Two prefixes: the reply list / profile feed under `post.list`, and the
    // parent's (and every ancestor's) `replyCount` under `post.thread`.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.post.list.key() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.post.thread.key() });

    unsub();
  });
});

describe("clearReplyFamilies", () => {
  it("empties both the draft family and the mutation family", () => {
    const draftBefore = replyDraftAtomFamily("parent-x");
    const mutationBefore = createReplyAtomFamily("parent-x");

    clearReplyFamilies();

    expect(replyDraftAtomFamily("parent-x")).not.toBe(draftBefore);
    expect(createReplyAtomFamily("parent-x")).not.toBe(mutationBefore);
  });
});
