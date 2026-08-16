import { beforeEach, describe, expect, it, vi } from "vitest";
import { installTestAuthClient } from "@/lib/auth-client";

/**
 * `waitForSession` is the fix for a race that has already bitten this codebase
 * once — see the comment in the module and the BUG note that used to sit in
 * `e2e/tests/specs/auth.spec.ts`. These tests pin the three behaviours that
 * make it correct, all of which are easy to break while "simplifying" it.
 */

interface FakeValue {
  data: { user: { username?: string | null } } | null;
}

let current: FakeValue = { data: null };
const listeners = new Set<(value: FakeValue) => void>();

// SAFETY: the recording fakes resolve the { data, error } shapes the app reads
// from the real client; the seam swaps only what each suite needs.
installTestAuthClient({
  sessionStore: {
    get: () => current,
    subscribe: (listener: (value: FakeValue) => void) => {
      listeners.add(listener);
      // nanostores fires immediately on subscribe — the whole reason the
      // module checks `.get()` first.
      listener(current);
      return () => listeners.delete(listener);
    },
  },
});

function emit(next: FakeValue): void {
  current = next;
  listeners.forEach((listener) => listener(current));
}

const { waitForHandle, waitForSession, waitForSignedOut } = await import("@/lib/session-sync");

beforeEach(() => {
  current = { data: null };
  listeners.clear();
  vi.useRealTimers();
});

describe("waitForSession", () => {
  it("resolves immediately, and without subscribing, when the predicate already holds", async () => {
    current = { data: { user: { username: "alexmercer" } } };

    await expect(waitForSession((value) => Boolean(value.data))).resolves.toBeUndefined();
    // No listener left behind: the early return is what makes the rest of the
    // implementation safe, since it guarantees the immediate `subscribe` call
    // can never satisfy the predicate.
    expect(listeners.size).toBe(0);
  });

  it("waits for a later update, then unsubscribes", async () => {
    const pending = waitForSession((value) => Boolean(value.data));
    expect(listeners.size).toBe(1);

    emit({ data: { user: { username: "alexmercer" } } });
    await expect(pending).resolves.toBeUndefined();

    expect(listeners.size).toBe(0);
  });

  it("ignores updates that don't satisfy the predicate", async () => {
    let settled = false;
    const pending = waitForSession((value) => Boolean(value.data?.user.username)).then(() => {
      settled = true;
    });

    emit({ data: { user: { username: null } } });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit({ data: { user: { username: "claimed" } } });
    await pending;
    expect(settled).toBe(true);
  });

  it("resolves on timeout rather than hanging — a stuck refetch must not wedge sign-out", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = waitForSession(() => false, 3000).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(2999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(true);
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("waitForSignedOut", () => {
  it("resolves once the store reports no session", async () => {
    current = { data: { user: { username: "alexmercer" } } };
    const pending = waitForSignedOut();

    emit({ data: null });
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("waitForHandle", () => {
  it("does not resolve while the signed-in user still has no handle", async () => {
    current = { data: { user: { username: null } } };

    let settled = false;
    const pending = waitForHandle().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    // This is the ordering the /welcome page depends on: navigate any earlier
    // and `useRequireHandle` reads a session with no username and sends the
    // person straight back.
    emit({ data: { user: { username: "claimed" } } });
    await pending;
    expect(settled).toBe(true);
  });
});
