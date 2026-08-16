import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { installTestAuthClient } from "@/lib/auth-client";

/**
 * A minimal nanostore-shaped double for BetterAuth's `sessionStore`. Real
 * nanostores call a new subscriber's listener immediately with the current
 * value (unlike `.listen`, which only fires on change) — `sessionAtom`'s
 * `onMount` comment leans on that guarantee, so the double has to honour it
 * too or a test could pass for the wrong reason.
 */
type SessionState = { value: SessionFixtureValue };
type SessionFixtureValue = {
  data: {
    user: {
      id: string;
      username: string | null;
      displayUsername: string | null;
      name: string;
      dateOfBirth?: string | Date;
    };
  } | null;
  isPending: boolean;
  isRefetching?: boolean;
};

const { state, listeners } = vi.hoisted(() => {
  const initial: SessionState = { value: { data: null, isPending: true } };
  return { state: initial, listeners: new Set<(value: SessionFixtureValue) => void>() };
});

function push(value: SessionFixtureValue) {
  state.value = value;
  listeners.forEach((listener) => listener(value));
}

const recordingSessionStore = {
  get: () => state.value,
  subscribe: (listener: (value: SessionFixtureValue) => void) => {
    listeners.add(listener);
    listener(state.value);
    return () => listeners.delete(listener);
  },
};

// SAFETY: the recording fakes resolve the { data, error } shapes the app reads
// from the real client; the seam swaps only what each suite needs.
installTestAuthClient({ sessionStore: recordingSessionStore });

/** After `vi.resetModules()`, re-seeds the fresh module instance with the same recording store. */
async function reinstallAfterReset(): Promise<void> {
  const freshAuthClient = await import("@/lib/auth-client");
  // SAFETY: recordingSessionStore pushes partial fixtures; the seam trusts the
  // suite to feed the shape the atoms read.
  freshAuthClient.installTestAuthClient({
    sessionStore: recordingSessionStore,
  });
}

import {
  isSignedInAtom,
  needsCompletionAtom,
  needsDobAtom,
  needsHandleAtom,
  sessionAtom,
  sessionPendingAtom,
  viewerAtom,
  viewerDateOfBirthAtom,
  viewerHandleAtom,
  viewerIdAtom,
} from "@/atoms/session";

const signedIn = {
  data: {
    user: { id: "u1", username: "alexmercer", displayUsername: "AlexMercer", name: "Alex Mercer" },
  },
  isPending: false,
  isRefetching: false,
};
// The fixture above has no date of birth — the completeness atoms below
// deliberately distinguish it from a session that declares one.
const signedInWithDob = {
  data: {
    user: {
      id: "u1",
      username: "alexmercer",
      displayUsername: "AlexMercer",
      name: "Alex Mercer",
      dateOfBirth: new Date("1995-01-01T00:00:00.000Z"),
    },
  },
  isPending: false,
  isRefetching: false,
};
const signedOut = { data: null, isPending: false, isRefetching: false };

/**
 * The fixtures above are deliberately partial. BetterAuth's real session
 * result also carries `isRefetching`, `error` and `refetch`; of those only
 * `isRefetching` feeds a derived atom — `sessionPendingAtom`'s
 * refetch-over-null hardening, exercised in its own test — and the rest
 * would add noise without adding coverage. The widening is funnelled through
 * this one helper rather than scattered as a cast per call site, so there is
 * exactly one place to revisit if `sessionAtom`'s shape ever starts mattering
 * to these tests.
 */
function setSession(store: ReturnType<typeof createStore>, value: SessionFixtureValue): void {
  // SAFETY: the fixture is deliberately partial — see the comment block above;
  // this single helper is the one place that widening happens.
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
    await reinstallAfterReset();
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

  it("sessionPendingAtom reflects isPending — and a refetch over null data, the transient-settle hardening", () => {
    const store = createStore();
    setSession(store, { data: null, isPending: true });
    expect(store.get(sessionPendingAtom)).toBe(true);

    setSession(store, signedOut);
    expect(store.get(sessionPendingAtom)).toBe(false);

    // BetterAuth can settle `{ data: null, isPending: false }` transiently
    // (an errored fetch keeps null data) while a refetch is in flight — that
    // must still read as pending, or the signed-in gate bounces to /login.
    setSession(store, { data: null, isPending: false, isRefetching: true });
    expect(store.get(sessionPendingAtom)).toBe(true);

    // A refetch over real data is not pending — nothing to wait for.
    setSession(store, { data: signedIn.data, isPending: false, isRefetching: true });
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

  it("viewerHandleAtom derives from the shared lib/user.ts helper", () => {
    const store = createStore();
    setSession(store, signedIn);
    // Prefers the normalised `username`, same rule as `handleOf` itself.
    expect(store.get(viewerHandleAtom)).toBe("alexmercer");
  });
});

/**
 * `needsHandleAtom` is what stands between an OAuth sign-up and a broken app:
 * `user.username` is null on social sign-up and every profile URL, follow list
 * and `user.byUsername` lookup is keyed on it. `useRequireHandle` and
 * `header.tsx` both read this one atom so they cannot disagree about which
 * sessions are incomplete.
 */
describe("needsHandleAtom", () => {
  it("is false when signed out — a visitor has no handle to claim", () => {
    const store = createStore();
    setSession(store, signedOut);
    expect(store.get(needsHandleAtom)).toBe(false);
  });

  it("is false for a signed-in user who already has a handle", () => {
    const store = createStore();
    setSession(store, signedIn);
    expect(store.get(needsHandleAtom)).toBe(false);
  });

  it("is true for a signed-in user whose username is null — the OAuth sign-up state", () => {
    const store = createStore();
    setSession(store, {
      data: { user: { id: "u2", username: null, displayUsername: null, name: "Grace Hopper" } },
      isPending: false,
    });
    expect(store.get(needsHandleAtom)).toBe(true);
  });

  it("falls back to displayUsername before declaring a handle missing", () => {
    const store = createStore();
    setSession(store, {
      data: { user: { id: "u3", username: null, displayUsername: "Grace", name: "Grace Hopper" } },
      isPending: false,
    });
    // `handleOf` accepts either column, so this session is complete enough to
    // build a profile URL from and must not be sent to /welcome.
    expect(store.get(needsHandleAtom)).toBe(false);
  });

  it("is false while the session is still pending, so nothing redirects on first paint", () => {
    const store = createStore();
    setSession(store, { data: null, isPending: true });
    expect(store.get(needsHandleAtom)).toBe(false);
  });
});

/**
 * The 15+ rule's client half: `needsDobAtom` is what stands between a session
 * that never declared a date of birth and the /welcome gate — a social
 * sign-up and any account that predates the rule. Together with
 * `needsHandleAtom` it defines `needsCompletionAtom`, the single "incomplete
 * sign-up" signal `use-require-handle.ts` gates on.
 */
describe("needsDobAtom / needsCompletionAtom", () => {
  it("is false when signed out — a visitor has no date of birth to declare", () => {
    const store = createStore();
    setSession(store, signedOut);
    expect(store.get(needsDobAtom)).toBe(false);
    expect(store.get(needsCompletionAtom)).toBe(false);
  });

  it("is true for a signed-in user who has never declared a date of birth", () => {
    const store = createStore();
    setSession(store, signedIn);
    expect(store.get(viewerDateOfBirthAtom)).toBeNull();
    expect(store.get(needsDobAtom)).toBe(true);
  });

  it("is false once the session carries a date of birth", () => {
    const store = createStore();
    setSession(store, signedInWithDob);
    expect(store.get(needsDobAtom)).toBe(false);
  });

  it("is false while the session is still pending, so nothing redirects on first paint", () => {
    const store = createStore();
    setSession(store, { data: null, isPending: true });
    expect(store.get(needsDobAtom)).toBe(false);
  });

  it("needsCompletionAtom is the union of the two completeness halves", () => {
    const store = createStore();
    // Handle present, DOB missing — the account that predates the 15+ rule.
    setSession(store, signedIn);
    expect(store.get(needsHandleAtom)).toBe(false);
    expect(store.get(needsCompletionAtom)).toBe(true);

    setSession(store, signedInWithDob);
    expect(store.get(needsCompletionAtom)).toBe(false);
  });
});

/**
 * `sessionSettledAtom` is the latch behind the app splash: false exactly
 * while the cold-load `/get-session` is in flight, true from then on. Each
 * test needs a FRESH latch — it is module state with no reset, and the whole
 * point is that it never flips back — so each one `vi.resetModules()`s and
 * re-imports `atoms/session`, the same trick the "seeded from
 * sessionStore.get()" test at the top of this file uses. The `@/lib/auth-client`
 * mock survives the reset, so `push()` still drives every instance.
 *
 * `store.sub(effect, ...)` is what mounts an `atomEffect` outside React, the
 * same way `theme.test.ts` mounts `themeClassEffect`.
 *
 * The effect's second job — removing the static splash from index.html — is
 * asserted through a `#app-splash` element created in jsdom, which mirrors
 * what the real index.html ships.
 */
function mountSplash(): HTMLElement {
  // Idempotent so a splash left behind by an earlier test can't shadow the
  // one this test asserts on (`getElementById` returns the first match).
  document.getElementById("app-splash")?.remove();
  const splash = document.createElement("div");
  splash.id = "app-splash";
  document.body.appendChild(splash);
  return splash;
}

describe("sessionSettledAtom", () => {
  it("is false while the first /get-session is still in flight", async () => {
    push({ data: null, isPending: true });
    vi.resetModules();
    await reinstallAfterReset();
    const fresh = await import("@/atoms/session");

    const store = createStore();
    const splash = mountSplash();
    const unsub = store.sub(fresh.sessionSettledEffect, () => {});
    expect(store.get(fresh.sessionSettledAtom)).toBe(false);
    // Still pending — the splash must stay on screen.
    expect(document.getElementById("app-splash")).toBe(splash);
    unsub();
  });

  it("latches true once the session resolves — signed out or in, either way", async () => {
    push(signedOut);
    vi.resetModules();
    await reinstallAfterReset();
    const fresh = await import("@/atoms/session");

    const store = createStore();
    const splash = mountSplash();
    const unsub = store.sub(fresh.sessionSettledEffect, () => {});
    expect(store.get(fresh.sessionSettledAtom)).toBe(true);
    // The same moment the latch trips, the static splash is removed.
    expect(document.getElementById("app-splash")).toBeNull();
    unsub();
    splash.remove();
  });

  it("stays true on a later pending — the sign-in refetch must not flash a splash", async () => {
    // The scenario the latch exists for: signing in flips `$sessionSignal`,
    // which refetches the session while `data` is still null, so
    // `sessionPendingAtom` reads true AGAIN after it has already resolved
    // once. A splash keyed on the raw flag would drop over the login form.
    push(signedOut);
    vi.resetModules();
    await reinstallAfterReset();
    const fresh = await import("@/atoms/session");

    const store = createStore();
    const splash = mountSplash();
    const unsub = store.sub(fresh.sessionSettledEffect, () => {});
    expect(store.get(fresh.sessionSettledAtom)).toBe(true);

    push({ data: null, isPending: true });
    expect(store.get(fresh.sessionSettledAtom)).toBe(true);
    // And it is not re-added — the element is gone for good.
    expect(document.getElementById("app-splash")).toBeNull();
    unsub();
    splash.remove();
  });
});
