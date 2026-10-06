import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { conversationParticipant, messageAttachment, user, userBlock } from "@my-tuums/db/schema";
import { appRouter } from "./router.js";
import { canViewMessageMedia } from "./message-media.js";
import {
  contextFor,
  createTestUser,
  recordedMessageEvents,
  truncateAll,
} from "./testing/harness.js";
import { closeDb } from "./testing/runtime.js";

beforeAll(truncateAll);
afterAll(async () => {
  await truncateAll();
  await closeDb();
});

it("invitations expose metadata only; joining restores full history and keeps one inbox row", async () => {
  const a = contextFor(await createTestUser());
  const b = contextFor(await createTestUser());
  const c = contextFor(await createTestUser());
  const { conversationId } = await call(
    appRouter.message.createGroup,
    { name: "Friends", recipientIds: [b.session!.user.id, c.session!.user.id] },
    { context: a },
  );
  const old = await call(
    appRouter.message.send,
    { conversationId, body: "Before you joined" },
    { context: a },
  );
  const requests = await call(appRouter.message.requests, {}, { context: b });
  expect(requests.items[0]).toMatchObject({
    conversationId,
    lastMessage: null,
    group: { name: "Friends" },
  });
  expect(await call(appRouter.message.unreadCount, {}, { context: b })).toEqual({
    unreadCount: 0,
    requestCount: 1,
  });
  await expect(
    call(appRouter.message.thread, { conversationId }, { context: b }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    call(appRouter.message.send, { conversationId, body: "Bypass join" }, { context: b }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    call(appRouter.message.accept, { conversationId }, { context: b }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await call(appRouter.message.join, { conversationId }, { context: b });
  await call(appRouter.message.join, { conversationId }, { context: c });
  expect(
    (await call(appRouter.message.thread, { conversationId }, { context: b })).items[0].id,
  ).toBe(old.id);
  expect((await call(appRouter.message.conversations, {}, { context: b })).items).toHaveLength(1);
  await call(appRouter.message.send, { conversationId, body: "Hello all" }, { context: c });
  expect((await call(appRouter.message.unreadCount, {}, { context: b })).unreadCount).toBe(1);
  expect(
    new Set(
      recordedMessageEvents
        .filter(
          (event) =>
            event.event.kind === "message" &&
            "conversationId" in event.event &&
            event.event.conversationId === conversationId,
        )
        .map((event) => event.userId),
    ),
  ).toEqual(new Set([a.session!.user.id, b.session!.user.id, c.session!.user.id]));
});

it("a blocked member requires explicit confirmation in either direction; shared group messages remain readable", async () => {
  const a = contextFor(await createTestUser());
  const b = contextFor(await createTestUser());
  await a.db
    .insert(userBlock)
    .values({ blockerId: a.session!.user.id, blockedId: b.session!.user.id });
  const { conversationId } = await call(
    appRouter.message.createGroup,
    { name: "Shared space", recipientIds: [b.session!.user.id] },
    { context: a },
  );
  expect((await call(appRouter.message.requests, {}, { context: b })).items).toHaveLength(1);
  expect(await call(appRouter.message.join, { conversationId }, { context: b })).toMatchObject({
    requiresConfirmation: true,
  });
  await expect(
    call(appRouter.message.thread, { conversationId }, { context: b }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await call(appRouter.message.join, { conversationId, confirmBlocked: true }, { context: b });
  await call(appRouter.message.send, { conversationId, body: "Group only" }, { context: b });
  expect(
    (await call(appRouter.message.thread, { conversationId }, { context: a })).items[0].body,
  ).toBe("Group only");
  await expect(
    call(appRouter.message.send, { recipientId: a.session!.user.id, body: "DM" }, { context: b }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("any member can rename and remove the creator; removal revokes text/media/report access and reinvitation restores all history", async () => {
  const a = contextFor(await createTestUser());
  const b = contextFor(await createTestUser());
  const { conversationId } = await call(
    appRouter.message.createGroup,
    { name: "Original", recipientIds: [b.session!.user.id] },
    { context: a },
  );
  await call(appRouter.message.join, { conversationId }, { context: b });
  const sent = await call(
    appRouter.message.send,
    { conversationId, body: "Keep history" },
    { context: b },
  );
  const key = `messages/${sent.id}/photo.png`;
  await a.db.insert(messageAttachment).values({
    id: crypto.randomUUID(),
    messageId: sent.id,
    kind: "image",
    mediaPath: `/media/${key}`,
    contentType: "image/png",
    byteSize: 10,
  });
  expect(await canViewMessageMedia(a.db, key, a.session!.user.id)).toBe(true);
  await call(appRouter.message.renameGroup, { conversationId, name: "Renamed" }, { context: b });
  await call(
    appRouter.message.removeMember,
    { conversationId, userId: a.session!.user.id },
    { context: b },
  );
  expect((await call(appRouter.message.conversations, {}, { context: a })).items).toHaveLength(0);
  expect(await canViewMessageMedia(a.db, key, a.session!.user.id)).toBe(false);
  await expect(
    call(
      appRouter.moderation.report,
      { targetType: "message", targetId: sent.id, reason: "harassment" },
      { context: a },
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    call(appRouter.message.thread, { conversationId }, { context: a }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    call(appRouter.message.send, { conversationId, body: "No" }, { context: a }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    call(appRouter.message.hide, { conversationId }, { context: a }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    call(
      appRouter.message.markRead,
      { conversationId, lastSeenMessageId: sent.id },
      { context: a },
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    call(appRouter.message.invite, { conversationId, userId: a.session!.user.id }, { context: b }),
  ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  await a.db
    .update(conversationParticipant)
    .set({ departedAt: new Date(Date.now() - 86_400_001) })
    .where(
      and(
        eq(conversationParticipant.conversationId, conversationId),
        eq(conversationParticipant.userId, a.session!.user.id),
      ),
    );
  await call(appRouter.message.send, { conversationId, body: "While absent" }, { context: b });
  await call(
    appRouter.message.invite,
    { conversationId, userId: a.session!.user.id },
    { context: b },
  );
  expect(await canViewMessageMedia(a.db, key, a.session!.user.id)).toBe(false);
  await call(appRouter.message.join, { conversationId }, { context: a });
  expect(
    (await call(appRouter.message.thread, { conversationId }, { context: a })).items.map(
      (row) => row.body,
    ),
  ).toEqual(["While absent", "Keep history"]);
  expect(await canViewMessageMedia(a.db, key, a.session!.user.id)).toBe(true);
  await call(appRouter.message.leaveGroup, { conversationId }, { context: a });
  await expect(
    call(appRouter.message.renameGroup, { conversationId, name: "No" }, { context: a }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("concurrent joins cannot exceed ten members, and account deletion preserves the group", async () => {
  const a = contextFor(await createTestUser());
  const people = await Promise.all(Array.from({ length: 10 }, () => createTestUser()));
  const { conversationId } = await call(
    appRouter.message.createGroup,
    { name: "Ten", recipientIds: people.slice(0, 9).map((p) => p.id) },
    { context: a },
  );
  await call(appRouter.message.invite, { conversationId, userId: people[9].id }, { context: a });
  const results = await Promise.allSettled(
    people.map((p) => call(appRouter.message.join, { conversationId }, { context: contextFor(p) })),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(9);
  const members = await a.db
    .select()
    .from(conversationParticipant)
    .where(
      and(
        eq(conversationParticipant.conversationId, conversationId),
        eq(conversationParticipant.membership, "joined"),
      ),
    );
  expect(members).toHaveLength(10);
  await a.db.delete(user).where(eq(user.id, a.session!.user.id));
  const survivor = people.find((p) => members.some((m) => m.userId === p.id))!;
  expect(
    (await call(appRouter.message.thread, { conversationId }, { context: contextFor(survivor) }))
      .group?.name,
  ).toBe("Ten");
});

it("pending invitations are idempotent and decline cooldown applies to every inviter", async () => {
  const a = contextFor(await createTestUser());
  const b = contextFor(await createTestUser());
  const c = contextFor(await createTestUser());
  const { conversationId } = await call(
    appRouter.message.createGroup,
    { name: "Quiet invitations", recipientIds: [b.session!.user.id, c.session!.user.id] },
    { context: a },
  );
  const events = recordedMessageEvents.length;
  await call(
    appRouter.message.invite,
    { conversationId, userId: b.session!.user.id },
    { context: a },
  );
  expect(recordedMessageEvents).toHaveLength(events);
  await call(appRouter.message.join, { conversationId }, { context: c });
  await call(appRouter.message.decline, { conversationId }, { context: b });
  await expect(
    call(appRouter.message.invite, { conversationId, userId: b.session!.user.id }, { context: c }),
  ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  expect((await call(appRouter.message.requests, {}, { context: b })).items).toHaveLength(0);
});

it("invitation budgets count recipients across groups rather than creation requests", async () => {
  const a = contextFor(await createTestUser());
  const people = await Promise.all(Array.from({ length: 9 }, () => createTestUser()));
  for (let batch = 0; batch < 3; batch++) {
    await call(
      appRouter.message.createGroup,
      { name: `Batch ${batch}`, recipientIds: people.map((p) => p.id) },
      { context: a },
    );
    await a.db
      .update(conversationParticipant)
      .set({ invitedAt: sql`${conversationParticipant.invitedAt} - 3600001` })
      .where(eq(conversationParticipant.invitedBy, a.session!.user.id));
  }
  await expect(
    call(
      appRouter.message.createGroup,
      { name: "Too many", recipientIds: people.map((p) => p.id) },
      { context: a },
    ),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
