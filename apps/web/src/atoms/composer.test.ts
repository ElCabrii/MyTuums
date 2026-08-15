import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { waitFor } from "@testing-library/react";

const fakeClient = { post: { create: vi.fn(), list: vi.fn() } };

installTestOrpc(createTanstackQueryUtils(fakeClient));

import { composerDraftAtom, createPostAtom } from "@/atoms/composer";
// `createPostAtom`'s `onSuccess` can't be handed a `set` — `atomWithMutation`'s
// options factory only receives a `Getter` — so it reaches the app's ONE
// singleton store directly (see the comment in composer.ts). That makes the
// singleton store, not a fresh one, the only place the draft-clearing side
// effect is actually observable.
import { store as singletonStore } from "@/lib/store";
import { queryClient as singletonQueryClient } from "@/lib/query-client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const STORAGE_KEY = "my-tuums.composer-draft";

beforeEach(() => {
  fakeClient.post.create.mockReset();
});

afterEach(() => {
  singletonQueryClient.clear();
  singletonStore.set(composerDraftAtom, "");
});

describe("composerDraftAtom persistence", () => {
  it("persists to localStorage and a fresh store reads it back", async () => {
    const store = createStore();
    store.set(composerDraftAtom, "half a thought");

    expect(localStorage.getItem(STORAGE_KEY)).toBe('"half a thought"');

    vi.resetModules();
    const fresh = await import("@/atoms/composer");
    expect(createStore().get(fresh.composerDraftAtom)).toBe("half a thought");
  });

  it("collapses a non-string stored value to an empty draft", async () => {
    localStorage.setItem(STORAGE_KEY, "42");
    vi.resetModules();
    const fresh = await import("@/atoms/composer");
    expect(createStore().get(fresh.composerDraftAtom)).toBe("");
  });
});

describe("createPostAtom", () => {
  it("tracks pending state and clears the draft on success", async () => {
    singletonStore.set(composerDraftAtom, "hello world");

    let resolveCreate!: (value: { id: string; content: string }) => void;
    fakeClient.post.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const unsub = singletonStore.sub(createPostAtom, () => {});
    singletonStore.get(createPostAtom).mutate({ content: "hello world" });

    await waitFor(() => expect(singletonStore.get(createPostAtom).isPending).toBe(true));

    resolveCreate({ id: "post-1", content: "hello world" });

    await waitFor(() => expect(singletonStore.get(createPostAtom).isSuccess).toBe(true));
    expect(singletonStore.get(composerDraftAtom)).toBe("");

    unsub();
  });

  it("surfaces an error and leaves the draft untouched", async () => {
    singletonStore.set(composerDraftAtom, "still typing");

    fakeClient.post.create.mockRejectedValue(new Error("boom"));

    const unsub = singletonStore.sub(createPostAtom, () => {});
    singletonStore.get(createPostAtom).mutate({ content: "still typing" });

    await waitFor(() => expect(singletonStore.get(createPostAtom).isError).toBe(true));
    // A failed post has nothing to reconcile — the draft is exactly what
    // the composer should still show so the person can retry or edit it.
    expect(singletonStore.get(composerDraftAtom)).toBe("still typing");

    unsub();
  });
});
