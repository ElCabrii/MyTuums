import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { ORPCError } from "@orpc/client";

const fakeClient = { user: { byUsername: vi.fn() } };

installTestOrpc(createTanstackQueryUtils(fakeClient));

import { profileAtomFamily } from "@/atoms/profile";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

beforeEach(() => {
  fakeClient.user.byUsername.mockReset();
});

describe("profileAtomFamily", () => {
  it("returns the same atom instance for the same username", () => {
    expect(profileAtomFamily("alice")).toBe(profileAtomFamily("alice"));
  });

  it("returns different atoms for different usernames", () => {
    expect(profileAtomFamily("alice")).not.toBe(profileAtomFamily("bob"));
  });

  it("resolves data from the wired-up oRPC client", async () => {
    fakeClient.user.byUsername.mockResolvedValue({ id: "u1", username: "carol" });

    const store = createStore();
    store.set(queryClientAtom, new QueryClient());
    const atom = profileAtomFamily("carol");
    const unsub = store.sub(atom, () => {});

    await vi.waitFor(() => expect(store.get(atom).data?.id).toBe("u1"));

    unsub();
  });

  // The whole point of spreading `retry` in AFTER `orpc.user.byUsername.queryOptions()`:
  // a 404'd handle must not be retried. If the spread order were reversed,
  // oRPC's own trailing spread would silently clobber this back to the
  // client's default (3 retries), and this test would see 4 calls instead of 1.
  it("does not retry a 404 — a handle that doesn't exist won't start existing", async () => {
    fakeClient.user.byUsername.mockRejectedValue(new ORPCError("NOT_FOUND"));

    const store = createStore();
    store.set(queryClientAtom, new QueryClient());
    const atom = profileAtomFamily("missing");
    const unsub = store.sub(atom, () => {});

    await vi.waitFor(() => expect(store.get(atom).isError).toBe(true));

    expect(fakeClient.user.byUsername).toHaveBeenCalledTimes(1);

    unsub();
  });

  it("removing an entry means the same username produces a brand new atom afterwards", () => {
    const before = profileAtomFamily("dave");
    profileAtomFamily.remove("dave");
    expect(profileAtomFamily("dave")).not.toBe(before);
  });
});
