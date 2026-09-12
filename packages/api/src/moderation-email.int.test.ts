import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { EmailDeliveryError, type OutgoingEmail } from "@my-tuums/auth";
import { moderationAction, moderationEmail, post, user } from "@my-tuums/db/schema";
import { anonContext, createTestUser, truncateAll } from "./testing/harness.js";
import { closeDb } from "./testing/runtime.js";
import { removePostEffect, restorePostEffect } from "./moderation-actions.js";
import { cleanupModerationEmails, deliverModerationEmails } from "./moderation-email.js";

beforeEach(truncateAll);
afterAll(closeDb);

async function removal() {
  const author = await createTestUser();
  const actor = await createTestUser();
  const [target] = await anonContext.db
    .insert(post)
    .values({
      authorId: author.id,
      content: "Committed moderation snapshot",
    })
    .returning();
  const args = { postId: target.id, actorId: actor.id, reason: "Synthetic moderation reason" };
  return { author, actor, target, args };
}

it("recovers a committed removal after losing its in-memory notice", async () => {
  const { author, target, args } = await removal();
  await anonContext.db.update(user).set({ localePreference: "fr" }).where(eq(user.id, author.id));
  await removePostEffect(anonContext, args);
  await anonContext.db.update(post).set({ content: "Later content" }).where(eq(post.id, target.id));
  const delivered: OutgoingEmail[] = [];
  const context = {
    ...anonContext,
    emailSender: {
      send(email: OutgoingEmail) {
        delivered.push(email);
        return Promise.resolve();
      },
    },
  };
  expect(await deliverModerationEmails(context)).toEqual({ sent: 1, retry: 0, failed: 0 });
  expect(delivered).toHaveLength(1);
  expect(delivered[0].text).toContain("Committed moderation snapshot");
  expect(delivered[0].text).not.toContain("Later content");
  expect(delivered[0].html).toContain('lang="fr"');
  const actionUrl = delivered[0].text.match(/https?:\/\/[^\s]+\/appeal\?token=([^\s]+)/)?.[1];
  expect(actionUrl).toBeDefined();
  expect(await anonContext.appealToken.verify(actionUrl!)).toMatchObject({ userId: author.id });
  expect(await anonContext.db.select().from(moderationEmail)).toEqual([]);
});

it("rolls back the moderation action when its durable notice cannot be stored", async () => {
  const { target, args } = await removal();
  await anonContext.db.$client
    .prepare(
      "CREATE TRIGGER reject_moderation_email BEFORE INSERT ON moderation_email BEGIN SELECT RAISE(ABORT, 'Synthetic notice failure'); END",
    )
    .run();
  try {
    await expect(removePostEffect(anonContext, args)).rejects.toThrow();
    const [unchanged] = await anonContext.db.select().from(post).where(eq(post.id, target.id));
    expect(unchanged.removedAt).toBeNull();
    expect(await anonContext.db.select().from(moderationAction)).toEqual([]);
  } finally {
    await anonContext.db.$client.prepare("DROP TRIGGER reject_moderation_email").run();
  }
});

it("retains recipient order while a temporary refusal backs off", async () => {
  const { target, actor, args } = await removal();
  await removePostEffect(anonContext, args);
  await restorePostEffect(anonContext.db, { postId: target.id, actorId: actor.id });
  let attempts = 0;
  const delivered: OutgoingEmail[] = [];
  const context = {
    ...anonContext,
    emailSender: {
      send(email: OutgoingEmail) {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new EmailDeliveryError(true));
        delivered.push(email);
        return Promise.resolve();
      },
    },
  };
  const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await deliverModerationEmails(context)).toEqual({ sent: 0, retry: 1, failed: 0 });
    expect(await deliverModerationEmails(context)).toEqual({ sent: 0, retry: 0, failed: 0 });
    expect(delivered).toEqual([]);
    await anonContext.db.update(moderationEmail).set({ nextAttemptAt: new Date(0) });
    await deliverModerationEmails(context);
    await deliverModerationEmails(context);
    expect(delivered).toHaveLength(2);
    expect(delivered[0].subject).toContain("removed");
    expect(delivered[1].subject).toContain("restored");
    expect(await anonContext.db.select().from(moderationEmail)).toEqual([]);
  } finally {
    diagnostics.mockRestore();
  }
});

it("fences a late sender after an expired lease is recovered", async () => {
  const { args } = await removal();
  await removePostEffect(anonContext, args);
  const firstEntered = deferred();
  const secondEntered = deferred();
  const firstRelease = deferred();
  const secondRelease = deferred();
  let attempts = 0;
  const context = {
    ...anonContext,
    emailSender: {
      send() {
        attempts += 1;
        if (attempts === 1) {
          firstEntered.resolve();
          return firstRelease.promise;
        }
        secondEntered.resolve();
        return secondRelease.promise;
      },
    },
  };
  const first = deliverModerationEmails(context);
  let second: Promise<Awaited<ReturnType<typeof deliverModerationEmails>>> | undefined;
  try {
    await firstEntered.promise;
    expect(await deliverModerationEmails(context)).toEqual({ sent: 0, retry: 0, failed: 0 });
    await anonContext.db.update(moderationEmail).set({ leaseUntil: new Date(0) });
    second = deliverModerationEmails(context);
    await secondEntered.promise;
    const [claimed] = await anonContext.db.select().from(moderationEmail);
    firstRelease.resolve();
    await first;
    expect(await anonContext.db.select().from(moderationEmail)).toEqual([claimed]);
    secondRelease.resolve();
    await second;
    expect(await anonContext.db.select().from(moderationEmail)).toEqual([]);
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await Promise.all([first, second]);
  }
});

it("removes pending private content on account deletion and retention expiry", async () => {
  const first = await removal();
  await removePostEffect(anonContext, first.args);
  expect(await anonContext.db.select().from(moderationEmail)).toHaveLength(1);
  await anonContext.db.delete(user).where(eq(user.id, first.author.id));
  expect(await anonContext.db.select().from(moderationEmail)).toEqual([]);
  const second = await removal();
  await removePostEffect(anonContext, second.args);
  await anonContext.db.update(moderationEmail).set({ expiresAt: new Date(0) });
  expect(await cleanupModerationEmails(anonContext.db)).toEqual({ removed: 1, failed: 0 });
  expect(await anonContext.db.select().from(moderationEmail)).toEqual([]);
});

function deferred() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release?.() };
}
