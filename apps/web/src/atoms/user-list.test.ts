import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import {
  decode,
  encode,
  followListDialogAtom,
  userListAtom,
  type FollowDirection,
} from "@/atoms/user-list";

describe("family key encoding", () => {
  it("puts the direction first", () => {
    expect(encode("alexmercer", "followers")).toBe("followers:alexmercer");
    expect(encode("alexmercer", "following")).toBe("following:alexmercer");
  });

  it("round-trips", () => {
    for (const direction of ["followers", "following"] as FollowDirection[]) {
      expect(decode(encode("alexmercer", direction))).toEqual({
        username: "alexmercer",
        direction,
      });
    }
  });

  it("stays total for a username containing the delimiter", () => {
    // Handles can't contain ":" today, but the key must not depend on a rule
    // enforced in another package. Splitting on the FIRST ":" is what makes
    // this round-trip rather than truncate.
    expect(decode(encode("odd:name", "followers"))).toEqual({
      username: "odd:name",
      direction: "followers",
    });
  });
});

describe("userListAtom", () => {
  it("returns the same atom instance for the same arguments", () => {
    // The family's whole contract: two components asking for the same list
    // share one observer rather than mounting two.
    expect(userListAtom("alexmercer", "followers")).toBe(userListAtom("alexmercer", "followers"));
  });

  it("returns a different atom for the other direction", () => {
    expect(userListAtom("alexmercer", "followers")).not.toBe(
      userListAtom("alexmercer", "following"),
    );
  });

  it("returns a different atom for a different handle", () => {
    expect(userListAtom("alexmercer", "followers")).not.toBe(userListAtom("samvega", "followers"));
  });
});

describe("followListDialogAtom", () => {
  const isOpen = (
    value: { username: string; direction: FollowDirection } | null,
    username: string,
    direction: FollowDirection,
  ) => value?.username === username && value.direction === direction;

  it("starts closed", () => {
    expect(createStore().get(followListDialogAtom)).toBeNull();
  });

  it("opens only the dialog whose identity matches", () => {
    const store = createStore();
    store.set(followListDialogAtom, { username: "alexmercer", direction: "followers" });
    const value = store.get(followListDialogAtom);

    expect(isOpen(value, "alexmercer", "followers")).toBe(true);
    // A profile renders both dialogs side by side — keying on username alone
    // would open both at once.
    expect(isOpen(value, "alexmercer", "following")).toBe(false);
  });

  it("closes when the handle changes, with no effect to reconcile it", () => {
    // This is what replaced the useEffect: navigating to another profile
    // changes the props, so the comparison goes false on its own.
    const store = createStore();
    store.set(followListDialogAtom, { username: "alexmercer", direction: "followers" });

    expect(isOpen(store.get(followListDialogAtom), "samvega", "followers")).toBe(false);
  });
});
