import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { ORPCError } from "@orpc/client";

const { fakeClient } = vi.hoisted(() => ({
  fakeClient: { post: { thread: vi.fn() } },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  const actual = await vi.importActual<typeof import("@/lib/orpc")>("@/lib/orpc");
  return {
    orpc: createTanstackQueryUtils(fakeClient),
    retryUnlessClientError: actual.retryUnlessClientError,
  };
});

import { clearThreadFamily, threadAtomFamily } from "@/atoms/thread";

beforeEach(() => {
  fakeClient.post.thread.mockReset();
});

describe("threadAtomFamily", () => {
  it("returns the same atom instance for the same post id", () => {
    expect(threadAtomFamily("post-1")).toBe(threadAtomFamily("post-1"));
  });

  it("returns different atoms for different post ids", () => {
    expect(threadAtomFamily("post-1")).not.toBe(threadAtomFamily("post-2"));
  });

  it("resolves data from the wired-up oRPC client", async () => {
    fakeClient.post.thread.mockResolvedValue({
      post: { id: "post-1", content: "hi" },
      ancestors: [],
      truncated: false,
    });

    const store = createStore();
    store.set(queryClientAtom, new QueryClient());
    const atom = threadAtomFamily("post-1");
    const unsub = store.sub(atom, () => {});

    await waitFor(() => expect(store.get(atom).data?.post.id).toBe("post-1"));

    unsub();
  });

  // A deleted post's thread 404s — retrying it on the way to that 404 would
  // just be three extra requests for the same eventual outcome.
  it("does not retry a 404", async () => {
    fakeClient.post.thread.mockRejectedValue(new ORPCError("NOT_FOUND"));

    const store = createStore();
    store.set(queryClientAtom, new QueryClient());
    const atom = threadAtomFamily("missing-post");
    const unsub = store.sub(atom, () => {});

    await waitFor(() => expect(store.get(atom).isError).toBe(true));
    expect(fakeClient.post.thread).toHaveBeenCalledTimes(1);

    unsub();
  });
});

describe("clearThreadFamily", () => {
  it("empties the family — the same id produces a brand new atom afterwards", () => {
    const before = threadAtomFamily("post-x");
    clearThreadFamily();
    expect(threadAtomFamily("post-x")).not.toBe(before);
  });
});
