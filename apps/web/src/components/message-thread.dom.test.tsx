import {
  createIdentity,
  publicIdentity,
  unlockIdentity,
  type LocalIdentity,
} from "@my-tuums/message-crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";

const fakeClient = {
  messageKey: { identity: vi.fn(), status: vi.fn() },
  message: {
    send: vi.fn(),
    conversations: vi.fn(),
    requests: vi.fn(),
    thread: vi.fn(),
    unreadCount: vi.fn(),
    markRead: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
    hide: vi.fn(),
    deleteMessage: vi.fn(),
    conversationWith: vi.fn(),
  },
};

installTestClient(fakeClient);

import { installTestClient, orpc } from "@/lib/orpc";
import type { MessageItem } from "@/lib/orpc";
import { messageThreadQueryOptions } from "@/lib/query-definitions";
import { clearMessageDrafts } from "@/atoms/messages";
import { MessageThreadPane, NewMessagePane } from "@/components/message-thread";
import { renderWithProviders } from "@/test/render";
import { createTestQueryClient } from "@/test/factories";
import type { QueryClient } from "@tanstack/react-query";

/** The seeded-thread cache shape read back in the first-contact test. */
type ThreadSeed = {
  pages: Array<{ items: Array<{ id: string }> }>;
};

/**
 * The thread pane's two navigation-adjacent contracts (PR #409 review):
 * opening a thread acknowledges through the newest DISPLAYED message even
 * when it is the viewer's own (a reply above an unread incoming message must
 * still clear it), and switching conversations never carries a draft across
 * — the route keys the pane by conversation id, which the switcher probe
 * below mirrors.
 */

const VIEWER = "viewer-1";
const OTHER = "user-2";
let local: LocalIdentity;

function pageMessage(overrides: Partial<MessageItem> = {}): MessageItem {
  return {
    id: crypto.randomUUID(),
    senderId: OTHER,
    body: "text",
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function seedThread(
  queryClient: QueryClient,
  conversationId: string,
  items: MessageItem[],
  lastReadAt: Date | null,
  hidden = false,
  otherUserId = OTHER,
) {
  queryClient.setQueryData(orpc.message.thread.key({ input: { conversationId } }), {
    pages: [
      {
        conversationId,
        lastReadAt,
        hidden,
        user: {
          id: otherUserId,
          name: "Other Person",
          username: "other",
          displayUsername: "Other",
          image: null,
        },
        items,
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
}

/** Renders the pane the way the route does — keyed by conversation id. */
function ConversationSwitcher() {
  const [conversationId, setConversationId] = useState("a");
  return (
    <div>
      <button type="button" onClick={() => setConversationId("b")}>
        switch to b
      </button>
      <MessageThreadPane key={conversationId} conversationId={conversationId} />
    </div>
  );
}

function makePane(element: ReactElement) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(["message-access", VIEWER], {
    local,
    identity: local.public,
    recovery: null,
  });
  const render = () => renderWithProviders(element, { signedInAs: { id: VIEWER }, queryClient });
  return { queryClient, render };
}

beforeEach(async () => {
  local = await unlockIdentity(await createIdentity(VIEWER));
  const recipient = await createIdentity(OTHER);
  fakeClient.messageKey.identity.mockResolvedValue(publicIdentity(recipient));
  fakeClient.messageKey.status.mockResolvedValue({ identity: local.public, recovery: null });
  fakeClient.message.markRead.mockReset();
  fakeClient.message.markRead.mockResolvedValue({ lastReadAt: new Date(), advanced: true });
  fakeClient.message.thread.mockReset();
  // Drafts are module state keyed by recipient — start every test clean.
  clearMessageDrafts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("acknowledges through the newest displayed message even when it is the viewer's own reply", async () => {
  // The regression: an outgoing newest message skipped the acknowledgment,
  // leaving the earlier incoming message unread forever — sending never
  // advances the stored cursor.
  const incoming = pageMessage({ id: "incoming-unread", createdAt: new Date(100) });
  const ownReply = pageMessage({ id: "own-newest", senderId: VIEWER, createdAt: new Date(200) });
  const { queryClient, render } = makePane(<MessageThreadPane conversationId="c-1" />);
  // Newest first, cursor never set: both rows are unread in principle.
  seedThread(queryClient, "c-1", [ownReply, incoming], null);
  fakeClient.message.thread.mockResolvedValue({
    conversationId: "c-1",
    lastReadAt: null,
    user: { id: OTHER, name: "Other", username: "other", displayUsername: "Other", image: null },
    items: [ownReply, incoming],
    nextCursor: null,
  });

  await render();

  await waitFor(() => {
    expect(fakeClient.message.markRead).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c-1", lastSeenMessageId: "own-newest" }),
      expect.anything(),
    );
  });
});

it("a hidden thread renders its history with the hidden notice above it", async () => {
  // Re-opening a hidden conversation (the profile's Message action) shows
  // the shared history, with a banner saying what state the thread is in —
  // not a history-less "new conversation" composer.
  const older = pageMessage({
    id: "history-row",
    body: "shared history",
    createdAt: new Date(100),
  });
  const { queryClient, render } = makePane(<MessageThreadPane conversationId="c-1" />);
  seedThread(queryClient, "c-1", [older], null, true);
  fakeClient.message.thread.mockResolvedValue({
    conversationId: "c-1",
    lastReadAt: null,
    hidden: true,
    user: { id: OTHER, name: "Other", username: "other", displayUsername: "Other", image: null },
    items: [older],
    nextCursor: null,
  });

  const screen = await render();

  await waitFor(() => expect(screen.getByText("shared history")).toBeVisible());
  expect(
    screen.getByText(
      "You hid this conversation — it is not in your messages. Sending a message brings it back.",
    ),
  ).toBeVisible();
});

it("the header kebab carries report-user and hide-conversation, hide only for an open thread", async () => {
  const { queryClient, render } = makePane(<MessageThreadPane conversationId="c-1" />);
  const now = new Date();
  seedThread(queryClient, "c-1", [], now);
  fakeClient.message.thread.mockResolvedValue({
    conversationId: "c-1",
    lastReadAt: now,
    hidden: false,
    user: { id: OTHER, name: "Other", username: "other", displayUsername: "Other", image: null },
    items: [],
    nextCursor: null,
  });

  const screen = await render();
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Write a message" })).toBeVisible(),
  );

  // Both actions live behind the one kebab — neither is a bare icon anymore.
  fireEvent.click(
    // ByRole names match the full accessible name already — no exact flag.
    screen.getByRole("button", { name: "More" }),
  );
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Report user" })).toBeVisible());
  expect(screen.getByRole("menuitem", { name: "Hide conversation" })).toBeVisible();
});

it("switching conversations starts from an empty composer — a draft never crosses recipients", async () => {
  const { queryClient, render } = makePane(<ConversationSwitcher />);
  const now = new Date();
  // Distinct recipients: drafts are keyed by recipient (so a draft typed in
  // one conversation can follow the viewer into that person's thread), and
  // the switcher must still land on an empty composer for a different one.
  seedThread(queryClient, "a", [], now, false, "user-a");
  seedThread(queryClient, "b", [], now, false, "user-b");
  fakeClient.message.thread.mockImplementation((input: { conversationId: string }) =>
    Promise.resolve({
      conversationId: input.conversationId,
      lastReadAt: now,
      user: {
        id: input.conversationId === "a" ? "user-a" : "user-b",
        name: "Other Person",
        username: "other",
        displayUsername: "Other",
        image: null,
      },
      items: [],
      nextCursor: null,
    }),
  );

  const screen = await render();
  const composer = () => screen.getByRole("textbox", { name: "Write a message" });
  await waitFor(() => expect(composer()).toBeVisible());

  fireEvent.change(composer(), { target: { value: "meant for A only" } });
  expect(composer()).toHaveValue("meant for A only");

  // The keyed remount inside the tree — exactly what the route does on a
  // conversation switch. The new composer starts empty.
  fireEvent.click(screen.getByRole("button", { name: "switch to b" }));
  await waitFor(() => expect(composer()).toHaveValue(""));
});

it("first contact seeds the thread and the draft typed during the move survives it", async () => {
  // The new-message pane's send: the conversation id arrives with the
  // message, and the URL moves to the real thread. Two contracts: the
  // thread's cache is seeded with the sent message (no skeleton
  // round-trip), and text typed around the remount is still in the
  // composer when the thread pane mounts.
  fakeClient.message.conversationWith.mockResolvedValue({
    conversationId: null,
    hidden: false,
    user: {
      id: OTHER,
      name: "Other Person",
      username: "other",
      displayUsername: "Other",
      image: null,
    },
  });
  fakeClient.message.unreadCount.mockResolvedValue({ unreadCount: 0, requestCount: 0 });
  fakeClient.message.send.mockResolvedValue({
    id: "server-row",
    conversationId: "c-new",
    senderId: VIEWER,
    body: "first contact",
    createdAt: new Date(),
  });
  fakeClient.message.thread.mockResolvedValue({
    conversationId: "c-new",
    lastReadAt: null,
    user: {
      id: OTHER,
      name: "Other Person",
      username: "other",
      displayUsername: "Other",
      image: null,
    },
    items: [
      {
        id: "server-row",
        senderId: VIEWER,
        body: "first contact",
        createdAt: new Date(),
        deletedAt: null,
      },
    ],
    nextCursor: null,
  });

  const { queryClient, render } = makePane(<NewMessagePane userId={OTHER} />);
  const screen = await render();
  const composer = () => screen.getByRole("textbox", { name: "Write a message" });
  await waitFor(() => expect(composer()).toBeVisible());

  fireEvent.change(composer(), { target: { value: "first contact" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    const failure = queryClient
      .getMutationCache()
      .getAll()
      .find((mutation) => mutation.state.error)?.state.error;
    if (failure) throw failure;
    expect(fakeClient.message.send).toHaveBeenCalled();
  });

  // The sent message is in the destination thread's cache under the exact
  // key its query mounts with.
  // SAFETY: the cache was seeded by `seedFirstMessageThread` one await ago —
  // the ThreadSeed shape is the one that function wrote.
  const seeded = queryClient.getQueryData(
    messageThreadQueryOptions("c-new").queryKey,
  ) as ThreadSeed;
  expect(seeded.pages[0].items.map((item) => item.id)).toEqual(["server-row"]);

  // The viewer keeps typing while the move happens, then the pane remounts
  // (what the route change does): the draft is still in the composer.
  fireEvent.change(composer(), { target: { value: "still typing" } });
  screen.unmount();
  const second = await renderWithProviders(
    <MessageThreadPane key="c-new" conversationId="c-new" />,
    { signedInAs: { id: VIEWER }, queryClient },
  );
  await waitFor(() => expect(second.getByText("first contact")).toBeVisible());
  expect(second.getByRole("textbox", { name: "Write a message" })).toHaveValue("still typing");
});
