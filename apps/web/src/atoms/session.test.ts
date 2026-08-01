import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { useSession } from "@/lib/auth-client";
import {
  isSignedInAtom,
  sessionAtom,
  sessionPendingAtom,
  viewerAtom,
  viewerHandleAtom,
  viewerIdAtom,
  viewerInitialsAtom,
} from "@/atoms/session";

// `sessionAtom`'s value type is whatever `useSession()` returns (see
// auth-client.ts) — reusing it here, rather than hand-writing a session
// fixture type, is what keeps these fixtures honest against a BetterAuth
// upgrade instead of silently drifting from the real shape.
type Session = ReturnType<typeof useSession>;
type SessionUser = NonNullable<Session["data"]>["user"];

const SIGNED_OUT: Session = {
  data: null,
  error: null,
  isPending: false,
  isRefetching: false,
  refetch: async () => {},
};

function makeSession(user: Partial<SessionUser> = {}): Session {
  const now = new Date();
  return {
    data: {
      session: {
        id: "session-1",
        createdAt: now,
        updatedAt: now,
        userId: user.id ?? "viewer-1",
        expiresAt: now,
        token: "token-1",
      },
      user: {
        id: "viewer-1",
        name: "Viewer",
        email: "viewer@example.com",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
        username: null,
        displayUsername: null,
        ...user,
      },
    },
    error: null,
    isPending: false,
    isRefetching: false,
    refetch: async () => {},
  };
}

describe("session atoms", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  describe("signed out", () => {
    beforeEach(() => {
      store.set(sessionAtom, SIGNED_OUT);
    });

    it("has no viewer", () => {
      expect(store.get(viewerAtom)).toBeNull();
    });

    it("is not signed in", () => {
      expect(store.get(isSignedInAtom)).toBe(false);
    });

    it("has no viewer id", () => {
      expect(store.get(viewerIdAtom)).toBeUndefined();
    });

    it("has no handle", () => {
      expect(store.get(viewerHandleAtom)).toBeNull();
    });

    it("falls back to U for initials", () => {
      expect(store.get(viewerInitialsAtom)).toBe("U");
    });
  });

  describe("signed in", () => {
    beforeEach(() => {
      store.set(
        sessionAtom,
        makeSession({
          id: "viewer-1",
          name: "Alex Mercer",
          username: "alexmercer",
          displayUsername: "AlexMercer",
        }),
      );
    });

    it("exposes the viewer", () => {
      expect(store.get(viewerAtom)?.id).toBe("viewer-1");
    });

    it("is signed in", () => {
      expect(store.get(isSignedInAtom)).toBe(true);
    });

    it("exposes the viewer id", () => {
      expect(store.get(viewerIdAtom)).toBe("viewer-1");
    });

    // handleOf prefers the normalised `username` over `displayUsername` — see
    // lib/user.test.ts for the unit test on the function itself. This just
    // confirms viewerHandleAtom actually reaches it rather than reimplementing
    // the preference inline.
    it("prefers the normalised username for the handle", () => {
      expect(store.get(viewerHandleAtom)).toBe("alexmercer");
    });

    it("derives initials from the name", () => {
      expect(store.get(viewerInitialsAtom)).toBe("AM");
    });
  });

  // Regression coverage for the header.tsx defect this migration fixes: the
  // old hand-rolled initials logic returned "" for a name of " ", where
  // `initialsOf` falls back to "U". Routing through viewerInitialsAtom is
  // what guarantees header.tsx gets the correct fallback instead of
  // reimplementing it.
  it("reaches initialsOf's fallback for a signed-in user with a blank name", () => {
    store.set(sessionAtom, makeSession({ name: " " }));
    expect(store.get(viewerInitialsAtom)).toBe("U");
  });

  it("falls back to displayUsername when there is no canonical username", () => {
    store.set(sessionAtom, makeSession({ username: null, displayUsername: "AlexMercer" }));
    expect(store.get(viewerHandleAtom)).toBe("AlexMercer");
  });

  it("tracks isPending independent of the session data", () => {
    store.set(sessionAtom, { ...SIGNED_OUT, isPending: true });
    expect(store.get(sessionPendingAtom)).toBe(true);

    store.set(sessionAtom, { ...SIGNED_OUT, isPending: false });
    expect(store.get(sessionPendingAtom)).toBe(false);
  });
});
