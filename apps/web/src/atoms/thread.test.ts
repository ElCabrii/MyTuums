import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { ORPCError } from "@orpc/client";

const fakeClient = { post: { thread: vi.fn() } };

installTestOrpc(createTanstackQueryUtils(fakeClient));

import { clearThreadFamily, threadAtomFamily } from "@/atoms/thread";
import { sessionAtom } from "@/atoms/session";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";
import {
  patchTestSessionUser,
  setTestSession,
  signedInSession,
  signedOutSession,
} from "@/test/auth-fixture";

beforeEach(() => {
  fakeClient.post.thread.mockReset();
});

describe("threadAtomFamily", () => {
  it("#353 holds a public thread for an incomplete signed-in viewer until session confirmation", async () => {
    setTestSession(signedInSession({ legalVersion: "stale" }));
    const store = createStore();
    const queryClient = new QueryClient();
    store.set(queryClientAtom, queryClient);
    const unsubscribeSession = store.sub(sessionAtom, () => {});
    fakeClient.post.thread.mockResolvedValue({
      post: { id: "held-post" },
      ancestors: [],
      truncated: false,
    });
    const thread = threadAtomFamily("held-post");
    const unsubscribe = store.sub(thread, () => {});
    try {
      await queryClient.invalidateQueries();
      expect(fakeClient.post.thread).not.toHaveBeenCalled();
      const ready = signedInSession().data;
      if (!ready) throw new Error("Expected a signed-in fixture");
      patchTestSessionUser(ready.user);
      await vi.waitFor(() => expect(store.get(thread).data?.post.id).toBe("held-post"));
    } finally {
      unsubscribe();
      unsubscribeSession();
      queryClient.clear();
    }
  });

  it("returns the same atom instance for the same post id", () => {
    expect(threadAtomFamily("post-1")).toBe(threadAtomFamily("post-1"));
  });

  it("returns different atoms for different post ids", () => {
    expect(threadAtomFamily("post-1")).not.toBe(threadAtomFamily("post-2"));
  });

  it("resolves data from the wired-up oRPC client", async () => {
    // A settled signed-out session: the permalink thread is a public read
    // (issue #353), so it fires without a viewer rather than staying idle.
    // The store is pre-seeded with the same object so the mount-time sync is
    // a no-op instead of a pending→anonymous transition that fires twice.
    const session = signedOutSession();
    setTestSession(session);
    fakeClient.post.thread.mockResolvedValue({
      post: { id: "post-1", content: "hi" },
      ancestors: [],
      truncated: false,
    });

    const store = createStore();
    store.set(queryClientAtom, new QueryClient());
    // SAFETY: the settled signed-out session the fake store holds (see the
    // note above) — the thread atoms read only whether the session settled
    // anonymously.
    store.set(sessionAtom, session as never);
    const atom = threadAtomFamily("post-1");
    const unsub = store.sub(atom, () => {});

    await vi.waitFor(() => expect(store.get(atom).data?.post.id).toBe("post-1"));
    expect(fakeClient.post.thread).toHaveBeenCalledTimes(1);

    unsub();
  });

  // A deleted post's thread 404s — retrying it on the way to that 404 would
  // just be three extra requests for the same eventual outcome.
  it("does not retry a 404", async () => {
    // Same public-read fixture as above — the 404 must come from the server,
    // not from the readiness gate holding the query back.
    const session = signedOutSession();
    setTestSession(session);
    fakeClient.post.thread.mockRejectedValue(new ORPCError("NOT_FOUND"));

    const store = createStore();
    store.set(queryClientAtom, new QueryClient());
    // SAFETY: the settled signed-out session the fake store holds (see the
    // pre-seed note in the test above) — the thread atoms read only whether
    // the session settled anonymously.
    store.set(sessionAtom, session as never);
    const atom = threadAtomFamily("missing-post");
    const unsub = store.sub(atom, () => {});

    await vi.waitFor(() => expect(store.get(atom).isError).toBe(true));
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
