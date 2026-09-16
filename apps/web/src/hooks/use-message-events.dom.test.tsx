import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { useMessageEvents } from "@/hooks/use-message-events";
import { orpc } from "@/lib/orpc";
import { messagesUnreadQueryOptions } from "@/lib/query-definitions";

/**
 * The message-event subscription contract (issue #408): one EventSource for
 * the app while the protected product is ready, refreshed lists on EVERY
 * (re)connection, and nothing but close on unmount. A fake EventSource
 * stands in — jsdom has none, and the assertions are about the client's
 * reaction to the stream's lifecycle, not the wire.
 */

const constructors: FakeEventSourceInstance[] = [];

/** jsdom has no EventSource; this fake records constructions and replays the
 * stream lifecycle the assertions drive. */
class FakeEventSourceInstance {
  onopen: (() => void) | null = null;
  private readonly listeners = new Map<string, (() => void)[]>();
  readonly closed = vi.fn();

  constructor(readonly url: string) {
    constructors.push(this);
  }

  addEventListener(kind: string, listener: () => void): void {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
  }

  emit(kind: string): void {
    if (kind === "open") {
      this.onopen?.();
      return;
    }
    for (const listener of this.listeners.get(kind) ?? []) listener();
  }

  close(): void {
    this.closed();
  }
}

function SubscriptionProbe() {
  useMessageEvents();
  return null;
}

beforeEach(() => {
  constructors.length = 0;
  vi.stubGlobal("EventSource", FakeEventSourceInstance);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderProbe() {
  return renderWithProviders(<SubscriptionProbe />, { signedInAs: true });
}

describe("useMessageEvents", () => {
  it("opens one stream, refreshes the message queries on connection and on every event kind, and closes on unmount", async () => {
    const { queryClient, unmount } = await renderProbe();

    await act(async () => {
      await vi.waitFor(() => expect(constructors).toHaveLength(1));
    });
    expect(constructors[0].url).toBe("/events/messages");

    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const refreshedKeys = () =>
      invalidateSpy.mock.calls
        .map(
          ([options]) =>
            // SAFETY: every invalidateQueries call in this test passes the
            // documented `{ queryKey }` object shape.
            (options as { queryKey?: readonly unknown[] }).queryKey,
        )
        .filter((key): key is readonly unknown[] => key !== undefined);

    // The INITIAL connection is the recovery path: whatever happened between
    // the first fetches and this stream must be refreshed.
    act(() => constructors[0].emit("open"));
    expect(refreshedKeys()).toContainEqual(orpc.message.conversations.key());
    expect(refreshedKeys()).toContainEqual(messagesUnreadQueryOptions().queryKey);

    // Every named event refreshes the same bounded key set.
    for (const kind of ["message", "read", "conversation", "unread"]) {
      act(() => constructors[0].emit(kind));
    }
    expect(refreshedKeys().length).toBeGreaterThanOrEqual(5);

    unmount();
    expect(constructors[0].closed).toHaveBeenCalled();
  });

  it("opens nothing while the protected product is not ready", async () => {
    const { unmount } = await renderWithProviders(<SubscriptionProbe />, {
      signedInAs: { legalAcceptedAt: null },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(constructors).toHaveLength(0);
    unmount();
  });
});
