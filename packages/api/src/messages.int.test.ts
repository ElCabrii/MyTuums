import {
  createIdentity,
  unlockIdentity,
  encryptMessage,
  decryptMessage,
  envelopeSchema,
  type LocalIdentity,
  type MessagePlaintext,
} from "@my-tuums/message-crypto";
import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import {
  conversation,
  conversationParticipant,
  jobIntent,
  messageAttachment,
  videoCleanup,
  message as messageTable,
  messageIdentity,
  user as userTable,
  moderationAction,
  report,
  video as videoTable,
} from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "./context.js";
import { cleanStreamUploads } from "./stream-cleanup.js";
import { failStreamVideo } from "./stream-processing.js";
import { canViewMessageMedia } from "./message-media.js";
import { parseMessageReportSnapshot } from "./message-report.js";
import { appRouter } from "./router.js";
import {
  contextFor,
  createTestUser,
  freshSessionFor,
  recordedMessageEvents,
  setUserBan,
  setUserRole,
  testStorageObjects,
  testStorage,
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

const keys = new Map<string, Promise<LocalIdentity>>();
const delivered = new Map<string, { plaintext: MessagePlaintext; envelope: string }>();

async function keyFor(context: Context, userId: string) {
  let pending = keys.get(userId);
  if (!pending) {
    pending = createIdentity(userId).then(unlockIdentity);
    keys.set(userId, pending);
  }
  const key = await pending;
  const [account] = await context.db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (account)
    await context.db
      .insert(messageIdentity)
      .values({
        userId,
        publicIdentity: JSON.stringify(key.public),
        backup: "synthetic-unused-backup",
        recoveryKeyId: "test",
      })
      .onConflictDoNothing();
  return key;
}

async function sendInput(context: Context, recipientId: string, body: string) {
  const senderId = context.session!.user.id;
  const sender = await keyFor(context, senderId);
  const recipient = await keyFor(
    context,
    recipientId === senderId ? "synthetic-self-target" : recipientId,
  );
  const plaintext: MessagePlaintext = {
    version: 1,
    id: randomUUID(),
    senderId,
    recipientId: recipient.public.userId,
    body,
  };
  const envelope = await encryptMessage(plaintext, sender, recipient.public);
  delivered.set(plaintext.id, { plaintext, envelope: JSON.stringify(envelope) });
  return { id: plaintext.id, recipientId, envelope };
}

async function send(context: Context, recipientId: string, body: string) {
  return call(appRouter.message.send, await sendInput(context, recipientId, body), { context });
}

async function disclosed(id: string) {
  const fixture = delivered.get(id)!;
  const reader = await keys.get(fixture.plaintext.recipientId)!;
  const sender = await keys.get(fixture.plaintext.senderId)!;
  return decryptMessage(
    envelopeSchema.parse(JSON.parse(fixture.envelope)),
    reader,
    sender.public,
    fixture.plaintext,
  );
}

async function readBody(item: { id: string; body: string | null; envelope: string | null }) {
  return item.envelope ? (await disclosed(item.id)).message.body : item.body;
}

async function disclosureFor(id: string) {
  return (await disclosed(id)).disclosure;
}

async function sendExpectError(context: Context, recipientId: string, body: string, code: string) {
  return expect(send(context, recipientId, body)).rejects.toMatchObject({ code });
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

  it("refuses plaintext writes from old clients instead of silently downgrading", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const input = {
      ...(await sendInput(contextFor(sender), recipient.id, "encrypted")),
      body: "plaintext",
    };
    await expect(
      call(appRouter.message.send, input, { context: contextFor(sender) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
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
    const [stored] = await contextFor(sender)
      .db.select()
      .from(messageTable)
      .where(eq(messageTable.id, sent.id));
    expect(stored.body).toBe("[encrypted]");
    expect(stored.envelope).not.toContain("hello there");

    const requests = await call(appRouter.message.requests, {}, { context: contextFor(recipient) });
    expect(requests.items.map((item) => item.conversationId)).toEqual([sent.conversationId]);
    expect(requests.items[0].user.id).toBe(sender.id);
    expect(requests.items[0].lastMessage?.body).toBeNull();
    expect(requests.items[0].lastMessage?.encrypted).toBe(true);

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
    expect(await Promise.all(thread.items.map(readBody))).toEqual([
      "second (into the void)",
      "first",
    ]);

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
    expect((await Promise.all(thread.items.map(readBody))).sort()).toEqual([
      "from alice",
      "from bob",
    ]);
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

    // The inbox row carries the same count for its badge — both sides'.
    const senderInbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(sender) },
    );
    expect(senderInbox.items[0]?.unreadCount).toBe(0);
    const recipientInbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    expect(recipientInbox.items[0]?.unreadCount).toBe(2);
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
  it("refuses the thread to a non-participant and across a block — but a HIDDEN side reads its own history, flagged", async () => {
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

    // Hiding is the viewer's own list-curation gesture, not a seal: the
    // explicit navigation back in (the profile's Message action resolving
    // this id) must show the shared history. The header flags the state so
    // the pane can say what sending will do, and the read cursor still
    // advances — otherwise re-activating later would tick the badge for
    // messages read here.
    await call(
      appRouter.message.hide,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    const hiddenThread = await call(
      appRouter.message.thread,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    expect(hiddenThread.hidden).toBe(true);
    expect(await Promise.all(hiddenThread.items.map(readBody))).toEqual(["private"]);
    const marked = await call(
      appRouter.message.markRead,
      { conversationId: sent.conversationId, lastSeenMessageId: sent.id },
      { context: contextFor(recipient) },
    );
    expect(marked.advanced).toBe(true);

    // The hidden side still receives no inbox row and no badge — reading is
    // not re-activating; only sending is.
    const counts = await call(
      appRouter.message.unreadCount,
      {},
      { context: contextFor(recipient) },
    );
    expect(counts).toEqual({ unreadCount: 0, requestCount: 0 });

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
      seen.push(...(await Promise.all(page.items.map(readBody))).map((body) => body ?? ""));
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

  it("resolves the conversation with a user — hidden resolves flagged, and only a block reads as none", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await send(contextFor(sender), recipient.id, "thread");

    const found = await call(
      appRouter.message.conversationWith,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );
    expect(found.conversationId).toBe(sent.conversationId);
    expect(found.hidden).toBe(false);

    // A hidden side still resolves, flagged — the profile's Message action
    // must open the real thread, not a history-less "new conversation".
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
    expect(hidden.conversationId).toBe(sent.conversationId);
    expect(hidden.hidden).toBe(true);

    await send(contextFor(recipient), sender.id, "back");
    const restored = await call(
      appRouter.message.conversationWith,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );
    expect(restored.conversationId).toBe(sent.conversationId);
    expect(restored.hidden).toBe(false);

    // A block in either direction reads as contactable only one way.
    await call(
      appRouter.moderation.block,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );
    const blocked = await call(
      appRouter.message.conversationWith,
      { userId: sender.id },
      { context: contextFor(recipient) },
    );
    expect(blocked.conversationId).toBeNull();
    expect(blocked.user).toBeNull();
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
        {
          targetType: "message",
          targetId: sent.id,
          reason: "harassment",
          disclosure: await disclosureFor(sent.id),
        },
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

  it("refuses undisclosed, forged and transplanted report evidence", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const selected = await send(contextFor(sender), recipient.id, "selected message");
    const neighbor = await send(contextFor(sender), recipient.id, "different message");
    const signed = await disclosureFor(selected.id);
    const forged = signed.slice(0, -10) + (signed.at(-10) === "A" ? "B" : "A") + signed.slice(-9);
    for (const disclosure of [undefined, forged, await disclosureFor(neighbor.id)]) {
      await expect(
        call(
          appRouter.moderation.report,
          {
            targetType: "message",
            targetId: selected.id,
            reason: "harassment",
            disclosure,
          },
          { context: contextFor(recipient) },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    const rows = await contextFor(sender)
      .db.select()
      .from(report)
      .where(eq(report.targetId, selected.id));
    expect(rows).toHaveLength(0);
  });

  it("discloses only the selected encrypted message, never neighboring messages", async () => {
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
      {
        targetType: "message",
        targetId: reported.id,
        reason: "harassment",
        disclosure: await disclosureFor(reported.id),
      },
      { context: contextFor(recipient) },
    );

    const [row] = await contextFor(recipient)
      .db.select({ snapshotContent: report.snapshotContent })
      .from(report)
      .where(and(eq(report.targetType, "message"), eq(report.targetId, reported.id)))
      .limit(1);
    const snapshot = parseMessageReportSnapshot(row?.snapshotContent ?? null);
    expect(snapshot).not.toBeNull();
    // Encrypted neighbors are never included in a selected-message disclosure.
    expect(snapshot!.messages).toHaveLength(1);
    expect(snapshot!.reportedMessageId).toBe(reported.id);
    expect(snapshot!.messages[0].body).toBe("message 12");
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
      {
        targetType: "message",
        targetId: sent.id,
        reason: "harassment",
        disclosure: await disclosureFor(sent.id),
      },
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
      {
        targetType: "message",
        targetId: taunt.id,
        reason: "harassment",
        disclosure: await disclosureFor(taunt.id),
      },
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
      expect(detail.target.message?.body).toBe("");
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
      {
        targetType: "message",
        targetId: unreported.id,
        reason: "harassment",
        disclosure: await disclosureFor(unreported.id),
      },
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
      {
        targetType: "message",
        targetId: taunt.id,
        reason: "harassment",
        disclosure: await disclosureFor(taunt.id),
      },
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

    const sent = await send(failing, recipient.id, "delivered anyway");
    expect(sent.body).toBeNull();

    const thread = await call(
      appRouter.message.thread,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    expect(await readBody(thread.items[0])).toBe("delivered anyway");
  });
});

async function sendMedia(
  input: {
    recipientId: string;
    body?: string;
    images?: File[];
    voice?: File;
    voiceDurationMs?: number;
    videoId?: string;
  },
  { context }: { context: Context },
) {
  const { body = "", ...media } = input;
  return call(
    appRouter.message.send,
    { ...media, ...(await sendInput(context, input.recipientId, body)) },
    { context },
  );
}

describe("message media attachments", () => {
  /** A genuine 2x2 PNG, the same fixture the post-attachment suites use. */
  const MESSAGE_PNG = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4y8AARAwQCgAfrgP19hgqWQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );

  const pngFile = (name = "photo.png"): File =>
    new File([MESSAGE_PNG], name, { type: "image/png" });

  /** A minimal but genuinely EBML-tagged WebM header, as MediaRecorder emits. */
  const WEBM_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
  const voiceFile = (name = "note.webm", type = "audio/webm"): File =>
    new File([WEBM_BYTES], name, { type });

  it("reports stored media when a corrupt encrypted caption cannot be disclosed", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const outsider = await createTestUser();
    const staff = await createTestUser();
    await setUserRole(staff.id, "moderator");
    const input = await sendInput(contextFor(sender), recipient.id, "unreadable caption");
    input.envelope.ciphertext =
      (input.envelope.ciphertext[0] === "A" ? "B" : "A") + input.envelope.ciphertext.slice(1);
    const sent = await call(
      appRouter.message.send,
      { ...input, images: [pngFile()] },
      { context: contextFor(sender) },
    );
    const key = sent.attachments[0].url.slice("/media/".length);
    expect(await canViewMessageMedia(contextFor(staff).db, key, staff.id)).toBe(false);
    const reportInput = {
      targetType: "message" as const,
      targetId: sent.id,
      reason: "harassment" as const,
    };
    await expect(
      call(appRouter.moderation.report, reportInput, { context: contextFor(outsider) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(
        appRouter.moderation.report,
        { ...reportInput, disclosure: "forged" },
        { context: contextFor(recipient) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await call(appRouter.moderation.report, reportInput, { context: contextFor(recipient) });
    const [row] = await contextFor(recipient)
      .db.select()
      .from(report)
      .where(eq(report.targetId, sent.id));
    expect(parseMessageReportSnapshot(row.snapshotContent)?.messages).toEqual([
      {
        id: sent.id,
        senderId: sender.id,
        senderHandle: sender.session.user.username,
        body: "",
        createdAt: sent.createdAt.toISOString(),
        attachments: sent.attachments,
      },
    ]);
    expect(await canViewMessageMedia(contextFor(staff).db, key, staff.id)).toBe(true);
  });

  it.each([false, true])(
    "returns one committed message and attachment for concurrent duplicate sends (block after first: %s)",
    async (blockAfterFirst) => {
      const sender = await createTestUser();
      const recipient = await createTestUser();
      const input = {
        ...(await sendInput(contextFor(sender), recipient.id, "retry me")),
        images: [pngFile()],
      };
      let releaseUploads: () => void = () => {};
      const uploads = new Promise<void>((resolve) => {
        releaseUploads = resolve;
      });
      let releaseSecond: () => void = () => {};
      const secondUpload = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      let uploadsStarted = 0;
      const context = {
        ...contextFor(sender),
        storage: {
          ...testStorage,
          async put(...args: Parameters<typeof testStorage.put>) {
            await testStorage.put(...args);
            // Both requests have passed the existence check before either batch runs.
            uploadsStarted += 1;
            if (uploadsStarted === 2) {
              releaseUploads();
              if (blockAfterFirst) await secondUpload;
            }
            await uploads;
          },
        },
      };
      const sends = [
        call(appRouter.message.send, input, { context }),
        call(appRouter.message.send, input, { context }),
      ];
      await Promise.race(sends);
      if (blockAfterFirst) {
        await call(appRouter.moderation.block, { userId: recipient.id }, { context });
        releaseSecond();
      }
      const results = await Promise.all(sends);
      expect(results[0]).toEqual(results[1]);
      expect(results[0].attachments).toHaveLength(1);
      expect(
        await context.db.select().from(messageTable).where(eq(messageTable.id, input.id)),
      ).toHaveLength(1);
      expect(
        await context.db
          .select()
          .from(messageAttachment)
          .where(eq(messageAttachment.messageId, input.id)),
      ).toHaveLength(1);
      if (!blockAfterFirst) {
        const changed = { ...input, envelope: { ...input.envelope, tag: "A".repeat(22) } };
        await expect(call(appRouter.message.send, changed, { context })).rejects.toMatchObject({
          code: "CONFLICT",
        });
      }
    },
  );

  it("sends an image group with a caption: rows, objects, and the thread projection agree", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    const sent = await sendMedia(
      { recipientId: recipient.id, body: "two photos", images: [pngFile(), pngFile("b.png")] },
      { context: contextFor(sender) },
    );
    expect(sent.attachments).toHaveLength(2);
    for (const attachment of sent.attachments) {
      expect(attachment.kind).toBe("image");
      expect(attachment.url).toMatch(/^\/media\/messages\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
      expect(attachment.width).toBe(2);
      expect(attachment.height).toBe(2);
    }
    // The objects exist under the projected paths.
    for (const attachment of sent.attachments) {
      expect(testStorageObjects.has(attachment.url.slice("/media/".length))).toBe(true);
    }

    const thread = await call(
      appRouter.message.thread,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    expect(thread.items[0].attachments).toHaveLength(2);
    expect(thread.items[0].attachments[0].position).toBe(0);
    expect(thread.items[0].attachments[1].position).toBe(1);

    // Encrypted captions stay out of server previews.
    const inbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    const row = inbox.items.find((item) => item.conversationId === sent.conversationId);
    expect(row?.lastMessage?.body).toBeNull();
    expect(row?.lastMessage?.encrypted).toBe(true);
    expect(await readBody(thread.items[0])).toBe("two photos");
    // Attachment kind remains visible metadata.
    expect(row?.lastMessage?.mediaKind).toBe("image");
  });

  it("sends a media-only message with an encrypted empty caption and visible media metadata", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    const sent = await sendMedia(
      { recipientId: recipient.id, images: [pngFile()] },
      { context: contextFor(sender) },
    );
    expect(await readBody(sent)).toBe("");

    const inbox = await call(
      appRouter.message.conversations,
      {},
      { context: contextFor(recipient) },
    );
    const row = inbox.items.find((item) => item.conversationId === sent.conversationId);
    expect(row?.lastMessage?.body).toBeNull();
    expect(row?.lastMessage?.mediaKind).toBe("image");
  });

  it("refuses image uploads that are not images, writing nothing anywhere", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    const objectsBefore = testStorageObjects.size;
    await expect(
      sendMedia(
        {
          recipientId: recipient.id,
          images: [new File(["definitely not a png"], "x.png", { type: "image/png" })],
        },
        { context: contextFor(sender) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // The refused send leaves no conversation for the pair — and therefore no
    // participants or messages of its own — and no object.
    expect((await pairRowCounts(contextFor(sender), sender.id, recipient.id)).conversations).toBe(
      0,
    );
    expect(testStorageObjects.size).toBe(objectsBefore);
  });

  it("refuses mixing media kinds in one message", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await expect(
      sendMedia(
        {
          recipientId: recipient.id,
          images: [pngFile()],
          voice: voiceFile(),
          voiceDurationMs: 1500,
        },
        { context: contextFor(sender) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a voice and an uploaded video in the same message", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const videoId = crypto.randomUUID();
    await sender.context.db.insert(videoTable).values({
      id: videoId,
      authorId: sender.id,
      state: "uploaded",
      byteSize: 100,
      streamCreatorId: `mytuums-test:${videoId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await expect(
      sendMedia(
        {
          recipientId: recipient.id,
          voice: voiceFile(),
          voiceDurationMs: 1500,
          videoId,
        },
        { context: contextFor(sender) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await pairRowCounts(contextFor(sender), sender.id, recipient.id)).conversations).toBe(
      0,
    );
  });

  it("sends a voice note: sniffed type wins, duration is the caller's declared measurement", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    const sent = await sendMedia(
      {
        recipientId: recipient.id,
        body: "listen",
        voice: voiceFile(),
        voiceDurationMs: 4200,
      },
      { context: contextFor(sender) },
    );
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0].kind).toBe("voice");
    expect(sent.attachments[0].contentType).toBe("audio/webm");
    expect(sent.attachments[0].durationMs).toBe(4200);
    expect(sent.attachments[0].url.endsWith(".webm")).toBe(true);

    const thread = await call(
      appRouter.message.thread,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    expect(thread.items[0].attachments[0].durationMs).toBe(4200);
  });

  it("refuses a voice note that is not audio and one that misses its declared duration", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await expect(
      sendMedia(
        {
          recipientId: recipient.id,
          voice: new File([MESSAGE_PNG], "fake.webm", { type: "audio/webm" }),
          voiceDurationMs: 1000,
        },
        { context: contextFor(sender) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      sendMedia({ recipientId: recipient.id, voice: voiceFile() }, { context: contextFor(sender) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("queues an uploaded video: the message lands now, the video flips to queued, and the job intent commits in the same batch", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await call(appRouter.user.follow, { userId: sender.id }, { context: contextFor(recipient) });
    const videoId = crypto.randomUUID();
    await sender.context.db.insert(videoTable).values({
      id: videoId,
      authorId: sender.id,
      state: "uploaded",
      byteSize: 123_456,
      streamCreatorId: `mytuums-test:${videoId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const sent = await sendMedia(
      { recipientId: recipient.id, body: "watch this", videoId },
      { context: contextFor(sender) },
    );
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0].kind).toBe("video");
    expect(sent.attachments[0].video?.state).toBe("queued");
    expect(sent.attachments[0].url).toBe(`/media/videos/${videoId}/master.m3u8`);

    const [row] = await sender.context.db
      .select()
      .from(videoTable)
      .where(eq(videoTable.id, videoId));
    expect(row.state).toBe("queued");
    const [intent] = await sender.context.db
      .select()
      .from(jobIntent)
      .where(eq(jobIntent.entityId, videoId));
    expect(intent).toMatchObject({ id: `video-${videoId}`, kind: "video", entityId: videoId });

    const thread = await call(
      appRouter.message.thread,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    expect(thread.items[0].attachments[0].video?.state).toBe("queued");
  });

  it.each([false, true])(
    "a video cancelled after pre-read leaves conversation state unchanged (hidden: %s)",
    async (hidden) => {
      const sender = await createTestUser();
      const recipient = await createTestUser();
      const context = contextFor(sender);
      if (hidden) {
        const sent = await send(context, recipient.id, "Earlier message");
        await call(appRouter.message.hide, { conversationId: sent.conversationId }, { context });
      }
      const before = await pairRowCounts(context, sender.id, recipient.id);
      const id = crypto.randomUUID();
      await context.db.insert(videoTable).values({
        id,
        authorId: sender.id,
        state: "uploaded",
        byteSize: 100,
        streamCreatorId: `mytuums-test:${id}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      // Deterministically land cancellation between the courtesy read and the
      // atomic send. The actual batch and all its writes still run against D1.
      const batch = context.db.batch.bind(context.db);
      const intercept = vi.spyOn(context.db, "batch").mockImplementationOnce(async (queries) => {
        await context.db
          .update(videoTable)
          .set({ state: "cancelled" })
          .where(eq(videoTable.id, id));
        return batch(queries);
      });
      try {
        await expect(
          sendMedia({ recipientId: recipient.id, videoId: id }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      } finally {
        intercept.mockRestore();
      }
      expect(await pairRowCounts(context, sender.id, recipient.id)).toEqual(before);
      const participants = await context.db
        .select({ status: conversationParticipant.status })
        .from(conversationParticipant)
        .where(eq(conversationParticipant.userId, sender.id));
      expect(participants).toEqual(hidden ? [{ status: "hidden" }] : []);
    },
  );

  it("refuses a video the caller does not own or that Stream has not accepted fully", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const other = await createTestUser();
    const [foreignId, processingId] = [crypto.randomUUID(), crypto.randomUUID()];
    await other.context.db.insert(videoTable).values({
      id: foreignId,
      authorId: other.id,
      state: "uploaded",
      byteSize: 1,
      streamCreatorId: `mytuums-test:${foreignId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await sender.context.db.insert(videoTable).values({
      id: processingId,
      authorId: sender.id,
      state: "processing",
      byteSize: 1,
      streamCreatorId: `mytuums-test:${processingId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await expect(
      sendMedia({ recipientId: recipient.id, videoId: foreignId }, { context: contextFor(sender) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      sendMedia(
        { recipientId: recipient.id, videoId: processingId },
        { context: contextFor(sender) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("hides a tombstoned message's attachments with its body in the thread", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await sendMedia(
      { recipientId: recipient.id, images: [pngFile()] },
      { context: contextFor(sender) },
    );
    await call(
      appRouter.message.deleteMessage,
      { messageId: sent.id },
      { context: contextFor(sender) },
    );
    const thread = await call(
      appRouter.message.thread,
      { conversationId: sent.conversationId },
      { context: contextFor(recipient) },
    );
    expect(thread.items[0].deletedAt).not.toBeNull();
    expect(thread.items[0].attachments).toHaveLength(0);
  });

  it("gates attachment media: participants yes, strangers and the signed-out no, moderators only through a report", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const stranger = await createTestUser();
    const sent = await sendMedia(
      { recipientId: recipient.id, images: [pngFile()] },
      { context: contextFor(sender) },
    );
    const key = sent.attachments[0].url.slice("/media/".length);

    expect(await canViewMessageMedia(contextFor(sender).db, key, sender.id)).toBe(true);
    expect(await canViewMessageMedia(contextFor(recipient).db, key, recipient.id)).toBe(true);
    expect(await canViewMessageMedia(contextFor(stranger).db, key, stranger.id)).toBe(false);
    expect(await canViewMessageMedia(contextFor(recipient).db, key, null)).toBe(false);

    const staff = await createTestUser();
    await setUserRole(staff.id, "moderator");
    expect(await canViewMessageMedia(contextFor(staff).db, key, staff.id)).toBe(false);
    await call(
      appRouter.moderation.report,
      {
        targetType: "message",
        targetId: sent.id,
        reason: "spam",
        disclosure: await disclosureFor(sent.id),
      },
      { context: contextFor(recipient) },
    );
    expect(await canViewMessageMedia(contextFor(staff).db, key, staff.id)).toBe(true);

    // A tombstone closes the participant pass; the report keeps the moderator's open.
    await call(
      appRouter.message.deleteMessage,
      { messageId: sent.id },
      { context: contextFor(sender) },
    );
    expect(await canViewMessageMedia(contextFor(sender).db, key, sender.id)).toBe(false);
    expect(await canViewMessageMedia(contextFor(staff).db, key, staff.id)).toBe(true);
  });

  it("retains every image in report evidence after the message is deleted", async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const sent = await sendMedia(
      { recipientId: recipient.id, images: [pngFile(), pngFile("second.png")] },
      { context: contextFor(sender) },
    );
    await call(
      appRouter.moderation.report,
      {
        targetType: "message",
        targetId: sent.id,
        reason: "spam",
        disclosure: await disclosureFor(sent.id),
      },
      { context: contextFor(recipient) },
    );
    const [row] = await contextFor(recipient)
      .db.select({ snapshotContent: report.snapshotContent })
      .from(report)
      .where(and(eq(report.targetType, "message"), eq(report.targetId, sent.id)))
      .limit(1);
    const snapshot = parseMessageReportSnapshot(row?.snapshotContent ?? null);
    expect(snapshot?.version).toBe(2);
    if (snapshot?.version !== 2) throw new Error("Expected a v2 message report snapshot.");
    const reported = snapshot.messages.find((entry) => entry.id === sent.id);
    expect(reported?.attachments.map((attachment) => attachment.url)).toEqual(
      sent.attachments.map((attachment) => attachment.url),
    );
    await call(
      appRouter.message.deleteMessage,
      { messageId: sent.id },
      { context: contextFor(sender) },
    );
    const staff = await createTestUser();
    await setUserRole(staff.id, "moderator");
    for (const attachment of sent.attachments) {
      expect(
        await canViewMessageMedia(
          contextFor(staff).db,
          attachment.url.slice("/media/".length),
          staff.id,
        ),
      ).toBe(true);
    }
  });
});

it("retires failed message videos without losing the message or blocking Stream cleanup", async () => {
  const sender = await createTestUser();
  const recipient = await createTestUser();
  const id = crypto.randomUUID();
  const db = sender.context.db;
  await db.insert(videoTable).values({
    id,
    authorId: sender.id,
    state: "uploaded",
    byteSize: 100,
    streamCreatorId: `mytuums-test:${id}`,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const sent = await sendMedia(
    { recipientId: recipient.id, videoId: id },
    { context: contextFor(sender) },
  );
  await failStreamVideo(db, id);
  await db
    .update(videoCleanup)
    .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
    .where(eq(videoCleanup.videoId, id));
  const result = await cleanStreamUploads(db, {
    remove: () => Promise.resolve(),
    findUploads: () => Promise.resolve([]),
  });
  expect(result.deferred).toBe(0);
  expect(await db.select().from(videoTable).where(eq(videoTable.id, id))).toHaveLength(0);
  const thread = await call(
    appRouter.message.thread,
    { conversationId: sent.conversationId },
    { context: contextFor(recipient) },
  );
  expect(thread.items[0].attachments[0]).toMatchObject({ kind: "video", video: null });
  expect(
    await db.select().from(messageAttachment).where(eq(messageAttachment.messageId, sent.id)),
  ).toHaveLength(1);
});
