import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";

// The observable guarantee this file pins: loading a module that reaches
// `atoms/session.ts` — before importing `@/test/render` or any other harness
// module — must not bind to the real BetterAuth session store.
//
// The real store's `onMount` schedules a `setTimeout(fetchSession, 0)` that
// hits `/get-session` the moment it gains a subscriber (and its `get()` at
// `sessionAtom`'s import time already arms that mount). The fake store's
// `subscribe` fires its listener synchronously and reaches no network. So a
// zero fetch count proves the fake — not the real client — is what
// `sessionAtom` captured.
//
// `vi.hoisted` runs before the static import below, so the fetch spy is in
// place before `@/atoms/session` evaluates — the same ordering a test author
// would otherwise have to remember by hand. The fake is installed by
// the Vitest setups (`setup-node.ts`/`setup-dom.ts`) during the setup phase, which runs before any
// test module is evaluated, so this import order is safe without any
// caller-side convention.
const { fetchCalls } = vi.hoisted(() => {
  const fetchCalls = { count: 0 };
  globalThis.fetch = () => {
    fetchCalls.count += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return { fetchCalls };
});

import { sessionAtom } from "@/atoms/session";

describe("auth fixture installs before test modules evaluate", () => {
  it("mounting sessionAtom triggers no /get-session fetch — the fake store is bound", async () => {
    const store = createStore();
    const unsub = store.sub(sessionAtom, () => {});
    // Let any scheduled fetch fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsub();

    expect(fetchCalls.count).toBe(0);
  });
});
