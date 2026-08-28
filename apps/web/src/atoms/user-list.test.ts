import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = { user: { followers: vi.fn(), following: vi.fn() } };

installTestOrpc(createTanstackQueryUtils(fakeClient));

import {
  clearUserListFamily,
  decode,
  encode,
  followListDialogAtom,
  userListAtom,
} from "@/atoms/user-list";

describe("user-list key encode/decode", () => {
  it("round-trips for both directions", () => {
    expect(decode(encode("alice", "followers"))).toEqual({
      direction: "followers",
      username: "alice",
    });
    expect(decode(encode("alice", "following"))).toEqual({
      direction: "following",
      username: "alice",
    });
  });

  // Direction is a fixed two-value union placed FIRST specifically so decode
  // can split on the first ":" and stay total no matter what the rest of the
  // key contains, even though real handles can't contain one today.
  it("splits only on the first ':', so a username containing one round-trips", () => {
    const key = encode("weird:name", "followers");
    expect(decode(key)).toEqual({ direction: "followers", username: "weird:name" });
  });
});

describe("userListAtom", () => {
  it("returns the same atom instance for the same (direction, username) pair", () => {
    expect(userListAtom("alice", "followers")).toBe(userListAtom("alice", "followers"));
  });

  it("returns different atoms for different directions of the same username", () => {
    expect(userListAtom("alice", "followers")).not.toBe(userListAtom("alice", "following"));
  });

  it("resolves data from the wired-up oRPC client", async () => {
    fakeClient.user.followers.mockResolvedValue({
      items: [{ id: "u1", username: "bob" }],
      nextCursor: null,
    });

    const store = createStore();
    store.set(queryClientAtom, new QueryClient());
    const atom = userListAtom("carol", "followers");
    const unsub = store.sub(atom, () => {});

    await vi.waitFor(() => {
      const result = store.get(atom);
      expect(result.data?.pages[0]?.items[0]?.username).toBe("bob");
    });

    expect(fakeClient.user.followers).toHaveBeenCalledWith(
      expect.objectContaining({ username: "carol" }),
      expect.anything(),
    );

    unsub();
  });
});

describe("clearUserListFamily", () => {
  it("empties the family — the same params produce a brand new atom afterwards", () => {
    const before = userListAtom("dave", "following");
    clearUserListFamily();
    expect(userListAtom("dave", "following")).not.toBe(before);
  });
});

describe("followListDialogAtom", () => {
  it("defaults to null, and holds the open dialog's identity", () => {
    const store = createStore();
    expect(store.get(followListDialogAtom)).toBeNull();

    store.set(followListDialogAtom, { username: "alice", direction: "followers" });
    expect(store.get(followListDialogAtom)).toEqual({ username: "alice", direction: "followers" });

    store.set(followListDialogAtom, null);
    expect(store.get(followListDialogAtom)).toBeNull();
  });
});
