import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import {
  conversation,
  conversationParticipant,
  message as messageTable,
  moderationAction,
  report,
} from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "./context.js";
import { parseMessageReportSnapshot } from "./message-report.js";
import { appRouter } from "./router.js";
import {
  contextFor,
  createTestUser,
  freshSessionFor,
  recordedMessageEvents,
  setUserBan,
  setUserRole,
  truncateAll,
  type TestUser,
} from "./testing/harness.js";
import { closeDb } from "./testing/runtime.js";

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

async function send(context: Context, recipientId: string, body: string) {
  return call(appRouter.message.send, { recipientId, body }, { context });
}

/** A send that must fail, asserting its error code in one step. */
function sendExpectError(context: Context, recipientId: string, body: string, code: string) {
  return expect(
    call(appRouter.message.send, { recipientId, body }, { context }),
  ).rejects.toMatchObject({ code });
}

/** Every messaging row the refused pair could have created — must stay empty. */
async function pairRowCounts(context: Context, a: string, b: string) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const conversations = await context.db
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.userAId, lo), eq(conversation.userBId, hi)));
  const participants = await context.db
    .select({ userId: conversationParticipant.userId })
    .from(conversationParticipant);
  const messages = await context.db.select({ id: messageTable.id }).from(messageTable);
  return {
    conversations: conversations.length,
    participants: participants.length,
    messages: messages.length,
  };
}

describe("message.send guards", () => {
  it("refuses messaging yourself", async () => {
    const me = await createTestUser();
    await expect(send(contextFor(me), me.id, "hi me")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses empty and whitespace-only bodies, and bodies past 2000 characters", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await expect(send(contextFor(sender), recipient.id, "")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(send(contextFor(sender), recipient.id, "   \n\t ")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(send(contextFor(sender), recipient.id, "x".repeat(2001))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a missing recipient with NOT_FOUND", async () => {
    const sender = await createTestUser();
    await expect(send(contextFor(sender), randomUUID(), "hello?")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a banned sender with FORBIDDEN", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await setUserBan(sender.id, { reason: "abuse", expiresAt: null });
    await expect(send(contextFor(sender), recipient.id, "let me in")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses sends across a block in either direction, reading the same NOT_FOUND a missing user reads — and leaves no rows behind", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    // Recipient blocks sender.
    await call(
      appRouter.moderation.block,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );
    await sendExpectError(contextFor(sender), recipient.id, "unblock me", "NOT_FOUND");
    // Sender blocks recipient: same refusal from the other side.
    const third = await createTestUser();
    await call(
      appRouter.moderation.block,
      { userId: recipient.id },
      { context: contextFor(sender) },
    );
    await sendExpectError(contextFor(sender), recipient.id, "still no", "NOT_FOUND");
    // The refused pair wrote nothing at all.
    const counts = await pairRowCounts(contextFor(sender), sender.id, recipient.id);
    expect(counts.conversations).toBe(0);
    expect(counts.participants).toBe(0);
    expect(counts.messages).toBe(0);
    // An unrelated, eligible pair still sends fine.
    await send(contextFor(sender), third.id, "fresh start");
  });
});

describe("conversation lifecycle", () => {
  it("lands the first message as a pending request when the recipient does not follow the sender — invisible to the inbox and the unread badge", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();

    const sent = await send(contextFor(sender), recipient.id, "hello there");

    const requests = await call(appRouter.message.requests, {}, { context: contextFor(recipient) });
    expect(requests.items.map((item) => item.conversationId)).toEqual([sent.conversationId]);
    expect(requests.items[0].user.id).toBe(sender.id);
    expect(requests.items[0].lastMessage?.body).toBe("hello there");

    const inbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    expect(inbox.items).toHaveLength(0);

    const counts = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(counts).toEqual({ unreadCount: 0, requestCount: 1 });
  });

  it("skips the request when the recipient already follows the sender", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });

    const sent = await send(contextFor(sender), recipient.id, "direct to inbox");

    const inbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    expect(inbox.items.map((item) => item.conversationId)).toEqual([sent.conversationId]);
    const counts = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(counts.requestCount).toBe(0);
    expect(counts.unreadCount).toBe(1);
  });

  it("accept moves the request to the inbox", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "please");

    await call(
      appRouter.message.accept,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );

    const inbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    expect(inbox.items.map((item) => item.conversationId)).toEqual([sent.conversationId]);
    const counts = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(counts.requestCount).toBe(0);
  });

  it("declining is silent and permanent for the decliner: later sends still succeed for the sender, who sees an ordinary thread", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "first");

    await call(
      appRouter.message.decline,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );

    // The sender was not told: their thread works and further sends succeed.
    await send(contextFor(sender), recipient.id, "second (into the void)");
    const thread = await call(
      appRouter.message.thread,
      { conversationId: sent.conversationId },
      { context: contextFor(sender) },
    );
    expect(thread.items.map((item) => item.body)).toEqual(["second (into the void)", "first"]);

    // The decliner sees nothing anywhere: no inbox row, no request, no badge.
    const inbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    expect(inbox.items).toHaveLength(0);
    const requests = await call(appRouter.message.requests, {}, { context: contextFor(recipient) });
    expect(requests.items).toHaveLength(0);
    const counts = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(counts).toEqual({ unreadCount: 0, requestCount: 0 });

    // A declined conversation never re-opens on its own: a THIRD message from
    // the sender still does not resurface it for the recipient.
    await send(contextFor(sender), recipient.id, "third");
    const afterThird = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(afterThird).toEqual({ unreadCount: 0, requestCount: 0 });
  });

  it("replying to a pending conversation is the implicit accept", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "hello");

    await send(contextFor(recipient), sender.id, "hi back");

    const inbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    expect(inbox.items.map((item) => item.conversationId)).toEqual([sent.conversationId]);
  });

  it("sending re-activates one's own hidden side — the one door back into a declined conversation", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "ping");
    await call(
      appRouter.message.decline,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );

    // The recipient changes their mind and messages the sender themselves.
    const again = await send(contextFor(recipient), sender.id, "actually, hello");
    expect(again.conversationId).toBe(sent.conversationId);
    const inbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    expect(inbox.items.map((item) => item.conversationId)).toEqual([sent.conversationId]);
  });

  it("concurrent first sends in both directions converge on one conversation with exactly the pair as participants", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();

    const [toBob, toAlice] = await Promise.all([
      send(contextFor(alice), bob.id, "from alice"),
      send(contextFor(bob), alice.id, "from bob"),
    ]);
    expect(toBob.conversationId).toBe(toAlice.conversationId);

    const participants = await contextFor(alice)
      .db.select({ userId: conversationParticipant.userId })
      .from(conversationParticipant)
      .where(eq(conversationParticipant.conversationId, toBob.conversationId));
    expect(participants.map((row) => row.userId).sort()).toEqual([alice.id, bob.id].sort());

    const thread = await call(
      appRouter.message.thread,
      { conversationId: toBob.conversationId },
      { context: contextFor(alice) },
    );
    expect(thread.items.map((item) => item.body).sort()).toEqual(["from alice", "from bob"]);
  });
});

describe("unread state and markRead", () => {
  it("never counts the caller's own messages", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    await send(contextFor(sender), recipient.id, "one");
    await send(contextFor(sender), recipient.id, "two");

    const asSender = await call(appRouter.message.unreadCount, {}, { context: contextFor(sender) });
    expect(asSender.unreadCount).toBe(0);
    const asRecipient = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(asRecipient.unreadCount).toBe(2);
  });

  it("advances the cursor through exactly the seen message — a later arrival stays unread", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    const first = await send(contextFor(sender), recipient.id, "seen");

    const marked = await call(
      appRouter.message.markRead,
      { conversationId: first.conversationId, lastSeenMessageId: first.id },
      { context: contextFor(recipient) },
    );
    expect(marked.advanced).toBe(true);

    // A message arriving after the page was read must stay unread.
    await send(contextFor(sender), recipient.id, "unseen");
    const counts = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(counts.unreadCount).toBe(1);
  });

  it("marking through an older message is an idempotent no-op that never moves the cursor backward", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    const first = await send(contextFor(sender), recipient.id, "one");
    const second = await send(contextFor(sender), recipient.id, "two");

    await call(
      appRouter.message.markRead,
      { conversationId: second.conversationId, lastSeenMessageId: second.id },
      { context: contextFor(recipient) },
    );
    const stale = await call(
      appRouter.message.markRead,
      { conversationId: first.conversationId, lastSeenMessageId: first.id },
      { context: contextFor(recipient) },
    );
    expect(stale.advanced).toBe(false);
    expect(stale.lastReadAt?.getTime()).toBe(second.createdAt.getTime());

    const counts = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(counts.unreadCount).toBe(0);
  });

  it("refuses a seen message from another conversation and an unknown conversation", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const other = await createTestUser();
    const mine = await send(contextFor(sender), recipient.id, "mine");
    const elsewhere = await send(contextFor(recipient), other.id, "elsewhere");

    await expect(
      call(
        appRouter.message.markRead,
        { conversationId: mine.conversationId, lastSeenMessageId: elsewhere.id },
        { context: contextFor(recipient) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(
        appRouter.message.markRead,
        { conversationId: randomUUID(), lastSeenMessageId: mine.id },
        { context: contextFor(recipient) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("timestamps strictly increase within a conversation, so a timestamp cursor can never consume a later tie", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const first = await send(contextFor(sender), recipient.id, "1");
    // Fire the rest in one tight burst — the most likely way to collide on
    // the same millisecond.
    const burst = await Promise.all([
      send(contextFor(sender), recipient.id, "2"),
      send(contextFor(sender), recipient.id, "3"),
      send(contextFor(sender), recipient.id, "4"),
    ]);

    const times = [first, ...burst].map((row) => row.createdAt.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  it("publishes a self-only read event for the acting user's other tabs", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "read me");
    recordedMessageEvents.length = 0;

    await call(
      appRouter.message.markRead,
      { conversationId: sent.conversationId, lastSeenMessageId: sent.id },
      { context: contextFor(recipient) },
    );

    expect(recordedMessageEvents).toEqual([
      { userId: recipient.id, event: { kind: "read", conversationId: sent.conversationId } },
    ]);
  });
});

describe("thread reads and pagination", () => {
  it("refuses the thread to a non-participant, a hidden side, and across a block", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const outsider = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "private");

    await expect(
      call(
        appRouter.message.thread,
        { conversationId: sent.conversationId },
        { context: contextFor(outsider) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await call(
      appRouter.message.hide,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    await expect(
      call(
        appRouter.message.thread,
        { conversationId: sent.conversationId },
        { context: contextFor(recipient) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await call(
      appRouter.moderation.block,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );
    await expect(
      call(
        appRouter.message.thread,
        { conversationId: sent.conversationId },
        { context: contextFor(sender) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("walks the thread exactly once through the keyset cursor", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const first = await send(contextFor(sender), recipient.id, "1");
    for (const body of ["2", "3", "4", "5"]) {
      await send(contextFor(sender), recipient.id, body);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await call(
        appRouter.message.thread,
        { conversationId: first.conversationId, cursor, limit: 2 },
        { context: contextFor(recipient) },
      );
      seen.push(...page.items.map((item) => item.body ?? ""));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      if (pages > 10) throw new Error("thread pagination looks like it is looping");
    } while (cursor);

    expect(seen).toEqual(["5", "4", "3", "2", "1"]);
  });

  it("rejects a malformed cursor", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await send(contextFor(sender), recipient.id, "one");
    for (const cursor of ["!!!not-base64url!!!", "eyJpZCI6MX0"]) {
      await expect(
        call(appRouter.message.conversations, { cursor }, { context: contextFor(recipient) }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("resolves the visible conversation with a user, and reports none for a hidden side or a block", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "thread");

    const found = await call(
      appRouter.message.conversationWith,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );
    expect(found.conversationId).toBe(sent.conversationId);

    await call(
      appRouter.message.hide,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    const hidden = await call(
      appRouter.message.conversationWith,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );
    expect(hidden.conversationId).toBeNull();

    await send(contextFor(recipient), sender.id, "back");
    const restored = await call(
      appRouter.message.conversationWith,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );
    expect(restored.conversationId).toBe(sent.conversationId);
  });

  it("resolves EVERY pair's conversation once the viewer has several — an unrelated participation row must not shadow the real one", async () => {
    const viewer = await createTestUser();
    const bob = await createTestUser();
    const carol = await createTestUser();
    const withBob = await send(contextFor(viewer), bob.id, "to bob");
    const withCarol = await send(contextFor(viewer), carol.id, "to carol");
    expect(withBob.conversationId).not.toBe(withCarol.conversationId);

    // The regression: a join over the viewer's participation rows left one
    // unrelated row per other conversation in the result, and limit 1 could
    // answer with its null conversation for one of the two pairs.
    const resolvedBob = await call(
      appRouter.message.conversationWith,
      { userId: bob.id },
      { context: contextFor(viewer) },
    );
    const resolvedCarol = await call(
      appRouter.message.conversationWith,
      { userId: carol.id },
      { context: contextFor(viewer) },
    );
    expect(resolvedBob.conversationId).toBe(withBob.conversationId);
    expect(resolvedCarol.conversationId).toBe(withCarol.conversationId);

    // And a third, never-contacted user resolves to no conversation at all.
    const stranger = await createTestUser();
    const resolvedStranger = await call(
      appRouter.message.conversationWith,
      { userId: stranger.id },
      { context: contextFor(viewer) },
    );
    expect(resolvedStranger.conversationId).toBeNull();
    expect(resolvedStranger.user?.id).toBe(stranger.id);
  });
});

describe("deleteMessage", () => {
  it("tombstones the sender's own message, redacts it everywhere, and is idempotent", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    const sent = await send(contextFor(sender), recipient.id, "regrettable");
    await send(contextFor(sender), recipient.id, "keeper");
    const newest = await send(contextFor(sender), recipient.id, "to be the preview");

    await call(
      appRouter.message.deleteMessage,
      { messageId: sent.id },
      { context: contextFor(sender) },
    );
    // Idempotent: the second call succeeds with the same stamp.
    const again = await call(
      appRouter.message.deleteMessage,
      { messageId: sent.id },
      { context: contextFor(sender) },
    );
    expect(again.deletedAt).not.toBeNull();

    const thread = await call(
      appRouter.message.thread,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    const tombstone = thread.items.find((item) => item.id === sent.id);
    expect(tombstone?.deletedAt).not.toBeNull();
    expect(tombstone?.body).toBeNull();

    // The preview follows the tombstone: metadata, never text.
    await call(
      appRouter.message.deleteMessage,
      { messageId: newest.id },
      { context: contextFor(sender) },
    );
    const inbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    expect(inbox.items[0].lastMessage?.body).toBeNull();
    expect(inbox.items[0].lastMessage).not.toBeNull();
  });

  it("refuses deletion of another user's message", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "not yours");

    await expect(
      call(
        appRouter.message.deleteMessage,
        { messageId: sent.id },
        { context: contextFor(recipient) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("notifies both users so open threads, previews and counts refresh", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "to delete");
    recordedMessageEvents.length = 0;

    await call(
      appRouter.message.deleteMessage,
      { messageId: sent.id },
      { context: contextFor(sender) },
    );

    const notified = recordedMessageEvents
      .filter((entry) => entry.event.kind === "message")
      .map((entry) => entry.userId)
      .sort();
    expect(notified).toEqual([recipient.id, sender.id].sort());
  });

  it("a deleted message no longer ticks the unread badge", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    const sent = await send(contextFor(sender), recipient.id, "unread then gone");

    const before = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(before.unreadCount).toBe(1);

    await call(
      appRouter.message.deleteMessage,
      { messageId: sent.id },
      { context: contextFor(sender) },
    );
    const after = await call(appRouter.message.unreadCount, {}, { context: contextFor(recipient) });
    expect(after.unreadCount).toBe(0);
  });
});

describe("blocks compose with every read", () => {
  it("a block drops the conversation from both sides' lists and counts", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    await send(contextFor(sender), recipient.id, "before the block");
    await send(contextFor(sender), recipient.id, "and still before");

    const before = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(before.unreadCount).toBe(2);

    await call(
      appRouter.moderation.block,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );

    const inbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    expect(inbox.items).toHaveLength(0);
    const counts = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(counts.unreadCount).toBe(0);

    // Unblocking restores the conversation — the block hid it, it never
    // mutated participation.
    await call(
      appRouter.moderation.unblock,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );
    const restored = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    expect(restored.items).toHaveLength(1);
  });
});

describe("reporting messages", () => {
  it("refuses a report from anyone but a participant of the conversation", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const outsider = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "private exchange");

    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "message", targetId: sent.id, reason: "harassment" },
        { context: contextFor(outsider) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "message", targetId: randomUUID(), reason: "harassment" },
        { context: contextFor(recipient) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("snapshots the reported message plus up to ten preceding ones in reading order", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    for (let i = 1; i <= 12; i++) {
      await send(contextFor(sender), recipient.id, `message ${i}`);
    }
    const thread = await call(
      appRouter.message.thread,
      {
        conversationId: (
          await call(appRouter.message.requests, {}, { context: contextFor(recipient) })
        ).items[0].conversationId,
        limit: 1,
      },
      { context: contextFor(recipient) },
    );
    const reported = thread.items[0]; // message 12

    await call(
      appRouter.moderation.report,
      { targetType: "message", targetId: reported.id, reason: "harassment" },
      { context: contextFor(recipient) },
    );

    const [row] = await contextFor(recipient)
      .db.select({ snapshotContent: report.snapshotContent })
      .from(report)
      .where(and(eq(report.targetType, "message"), eq(report.targetId, reported.id)))
      .limit(1);
    const snapshot = parseMessageReportSnapshot(row?.snapshotContent ?? null);
    expect(snapshot).not.toBeNull();
    // The window is the reported message plus AT MOST ten before it.
    expect(snapshot!.messages).toHaveLength(11);
    expect(snapshot!.reportedMessageId).toBe(reported.id);
    expect(snapshot!.messages.at(-1)?.body).toBe("message 12");
    expect(snapshot!.messages[0].body).toBe("message 2");
    // Reading order: oldest first — each row's number is one more than the last.
    expect(snapshot!.messages.map((m) => Number(m.body.split(" ")[1]))).toEqual(
      snapshot!.messages.map((_m, index) => index + 2),
    );
  });

  it("a participant may report across a block and after the sender deleted the message — the snapshot keeps the evidence", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "you'll regret this");

    await call(
      appRouter.message.deleteMessage,
      { messageId: sent.id },
      { context: contextFor(sender) },
    );
    await call(
      appRouter.moderation.block,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );

    await call(
      appRouter.moderation.report,
      { targetType: "message", targetId: sent.id, reason: "harassment" },
      { context: contextFor(recipient) },
    );

    const [row] = await contextFor(recipient)
      .db.select({ snapshotContent: report.snapshotContent })
      .from(report)
      .where(and(eq(report.targetType, "message"), eq(report.targetId, sent.id)))
      .limit(1);
    const snapshot = parseMessageReportSnapshot(row?.snapshotContent ?? null);
    expect(snapshot?.messages.at(-1)?.body).toBe("you'll regret this");
  });
});

describe("the moderation view of a message case", () => {
  async function moderator(): Promise<TestUser> {
    const staff = await createTestUser();
    await setUserRole(staff.id, "moderator");
    return freshSessionFor(staff);
  }

  it("carries the live message, the sender projection, and each report's parsed snapshot", async () => {
    const staff = await moderator();
    const sender = await createTestUser();
    const victim = await createTestUser();
    const taunt = await send(contextFor(sender), victim.id, "reported words");

    await call(
      appRouter.moderation.report,
      { targetType: "message", targetId: taunt.id, reason: "harassment" },
      { context: contextFor(victim) },
    );

    const queue = await call(appRouter.moderation.queue, {}, { context: contextFor(staff) });
    const row = queue.items.find(
      (item) => item.targetType === "message" && item.targetId === taunt.id,
    );
    expect(row).toBeDefined();
    expect(row?.preview?.kind).toBe("message");
    if (row?.preview?.kind === "message") {
      expect(row.preview.sender.id).toBe(sender.id);
      expect(row.preview.excerpt).toContain("reported words");
    }

    const detail = await call(
      appRouter.moderation.case,
      { targetType: "message", targetId: taunt.id },
      { context: contextFor(staff) },
    );
    expect(detail.target.kind).toBe("message");
    if (detail.target.kind === "message") {
      expect(detail.target.message?.body).toBe("reported words");
      expect(detail.target.sender?.id).toBe(sender.id);
      expect(detail.target.evidence).toHaveLength(1);
      expect(detail.target.evidence[0].snapshot.reportedMessageId).toBe(taunt.id);
      expect(detail.target.evidence[0].snapshot.messages.at(-1)?.body).toBe("reported words");
    }
  });

  it("refuses an UNREPORTED message — a moderator holding a bare id must not read private text nobody submitted", async () => {
    const staff = await moderator();
    const sender = await createTestUser();
    const victim = await createTestUser();
    const unreported = await send(contextFor(sender), victim.id, "never reported");

    // The report-only trust boundary (docs/security.md): the case view is the
    // moderator's sole window into DMs, and only a participant's report opens
    // it. An id alone — even a moderator's — reads as missing.
    await expect(
      call(
        appRouter.moderation.case,
        { targetType: "message", targetId: unreported.id },
        { context: contextFor(staff) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Once reported, the same moderator reads the case — including content
    // the sender has since deleted, from the report's own snapshot.
    await call(
      appRouter.message.deleteMessage,
      { messageId: unreported.id },
      { context: contextFor(sender) },
    );
    await call(
      appRouter.moderation.report,
      { targetType: "message", targetId: unreported.id, reason: "harassment" },
      { context: contextFor(victim) },
    );
    const detail = await call(
      appRouter.moderation.case,
      { targetType: "message", targetId: unreported.id },
      { context: contextFor(staff) },
    );
    expect(detail.target.kind).toBe("message");
    if (detail.target.kind === "message") {
      expect(detail.target.evidence[0]?.snapshot.messages.at(-1)?.body).toBe("never reported");
    }
  });

  it("resolves against the sender: reports stamped, audit row on the sender, message link in details", async () => {
    const staff = await moderator();
    const sender = await createTestUser();
    const victim = await createTestUser();
    const taunt = await send(contextFor(sender), victim.id, "resolve me");

    await call(
      appRouter.moderation.report,
      { targetType: "message", targetId: taunt.id, reason: "harassment" },
      { context: contextFor(victim) },
    );
    const resolved = await call(
      appRouter.moderation.resolve,
      { targetType: "message", targetId: taunt.id, outcome: "actioned", note: "warned the sender" },
      { context: contextFor(staff) },
    );
    expect(resolved.resolved).toBe(1);

    const [audit] = await contextFor(staff)
      .db.select()
      .from(moderationAction)
      .where(eq(moderationAction.action, "case_resolved"))
      .limit(1);
    expect(audit?.targetType).toBe("user");
    expect(audit?.targetUserId).toBe(sender.id);
    expect(audit?.details).toMatchObject({
      outcome: "actioned",
      messageTargetId: taunt.id,
    });

    // The victim's report was stamped resolved.
    const [stamped] = await contextFor(staff)
      .db.select({ resolvedAt: report.resolvedAt })
      .from(report)
      .where(and(eq(report.targetType, "message"), eq(report.targetId, taunt.id)))
      .limit(1);
    expect(stamped?.resolvedAt).not.toBeNull();
  });
});

describe("the push layer is strictly best-effort", () => {
  it("a committed send survives a notifier outage without an error response", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const failing: Context = {
      ...contextFor(sender),
      messageNotifier: {
        notify: () => Promise.reject(new Error("synthetic hub outage")),
      },
    };

    const sent = await call(
      appRouter.message.send,
      { recipientId: recipient.id, body: "delivered anyway" },
      { context: failing },
    );
    expect(sent.body).toBe("delivered anyway");

    const thread = await call(
      appRouter.message.thread,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    expect(thread.items[0].body).toBe("delivered anyway");
  });
});
