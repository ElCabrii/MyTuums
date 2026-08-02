import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";

/**
 * A minimal nanostore-shaped double for BetterAuth's `sessionStore`. Real
 * nanostores call a new subscriber's listener immediately with the current
 * value (unlike `.listen`, which only fires on change) — `sessionAtom`'s
 * `onMount` comment leans on that guarantee, so the double has to honour it
 * too or a test could pass for the wrong reason.
 */
const { state, listeners } = vi.hoisted(() => {
  const initial: { value: unknown } = { value: { data: null, isPending: true } };
  return { state: initial, listeners: new Set<(value: unknown) => void>() };
});

function push(value: unknown) {
  state.value = value;
  listeners.forEach((listener) => listener(value));
}

vi.mock("@/lib/auth-client", () => ({
  sessionStore: {
    get: () => state.value,
    subscribe: (listener: (value: unknown) => void) => {
      listeners.add(listener);
      listener(state.value);
      return () => listeners.delete(listener);
    },
  },
}));

import {
  isSignedInAtom,
  sessionAtom,
  sessionPendingAtom,
  viewerAtom,
  viewerHandleAtom,
  viewerIdAtom,
  viewerInitialsAtom,
} from "@/atoms/session";

const signedIn = {
  data: {
    user: { id: "u1", username: "alexmercer", displayUsername: "AlexMercer", name: "Alex Mercer" },
  },
  isPending: false,
};
const signedOut = { data: null, isPending: false };

/**
 * The fixtures above are deliberately partial. BetterAuth's real session
 * result also carries `isRefetching`, `error` and `refetch`, none of which any
 * derived atom here reads — spelling them out would add noise without adding
 * coverage. The widening is funnelled through this one helper rather than
 * scattered as a cast per call site, so there is exactly one place to revisit
 * if `sessionAtom`'s shape ever starts mattering to these tests.
 */
function setSession(store: ReturnType<typeof createStore>, value: unknown): void {
  store.set(sessionAtom, value as never);
}

describe("sessionAtom", () => {
  // `sessionAtom = atom(sessionStore.get())` captures its value at MODULE
  // IMPORT time, not lazily — the same reason `feed-scope.ts`'s `getOnInit`
  // matters. `vi.resetModules()` + a fresh dynamic import is what lets this
  // test control what "import time" sees, rather than relying on whatever the
  // top-of-file hoisted default happens to be.
  it("is seeded from sessionStore.get() with no null-then-real-value flash", async () => {
    push(signedIn);
    vi.resetModules();
    const fresh = await import("@/atoms/session");

    // No store.sub — a bare first get on a never-before-touched store.
    expect(createStore().get(fresh.sessionAtom)).toEqual(signedIn);
  });

  it("tracks values pushed after onMount subscribes", () => {
    push(signedOut);
    const store = createStore();
    const seen: unknown[] = [];
    const unsub = store.sub(sessionAtom, () => seen.push(store.get(sessionAtom)));

    push(signedIn);

    expect(store.get(sessionAtom)).toEqual(signedIn);
    expect(seen.at(-1)).toEqual(signedIn);

    unsub();
  });

  it("unsubscribes from the nanostore on unmount", () => {
    push(signedOut);
    const store = createStore();
    const before = listeners.size;
    const unsub = store.sub(sessionAtom, () => {});
    expect(listeners.size).toBe(before + 1);

    unsub();
    expect(listeners.size).toBe(before);
  });
});

describe("derived session atoms", () => {
  // These exercise the derivation logic against `sessionAtom` directly —
  // `sessionAtom` is a plain writable atom, so setting it on a fresh store
  // sidesteps the import-time-capture behaviour covered above.

  it("sessionPendingAtom reflects isPending", () => {
    const store = createStore();
    setSession(store, { data: null, isPending: true });
    expect(store.get(sessionPendingAtom)).toBe(true);

    setSession(store, signedOut);
    expect(store.get(sessionPendingAtom)).toBe(false);
  });

  it("isSignedInAtom / viewerAtom / viewerIdAtom are null-ish when signed out", () => {
    const store = createStore();
    setSession(store, signedOut);
    expect(store.get(isSignedInAtom)).toBe(false);
    expect(store.get(viewerAtom)).toBeNull();
    expect(store.get(viewerIdAtom)).toBeUndefined();
  });

  it("isSignedInAtom / viewerAtom / viewerIdAtom reflect a signed-in user", () => {
    const store = createStore();
    setSession(store, signedIn);
    expect(store.get(isSignedInAtom)).toBe(true);
    expect(store.get(viewerAtom)?.id).toBe("u1");
    expect(store.get(viewerIdAtom)).toBe("u1");
  });

  it("viewerHandleAtom / viewerInitialsAtom derive from the shared lib/user.ts helpers", () => {
    const store = createStore();
    setSession(store, signedIn);
    // Prefers the normalised `username`, same rule as `handleOf` itself.
    expect(store.get(viewerHandleAtom)).toBe("alexmercer");
    expect(store.get(viewerInitialsAtom)).toBe("AM");
  });
});
