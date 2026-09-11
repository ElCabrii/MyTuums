import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { appeal, moderationAction, notification, report, session, user } from "@my-tuums/db/schema";
import { db } from "./testing/runtime.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  freshSessionFor,
  setUserRole,
  testEmailSender,
  truncateAll,
} from "./testing/harness.js";
import { banUser, setRole, suspendUser, unbanUser } from "./moderation-actions.js";
import { appRouter } from "./router.js";

beforeEach(truncateAll);
afterAll(truncateAll);

describe("atomic D1 account moderation", () => {
  it("case resolution rolls back on report-stamp failure and concurrent retries resolve only once", async () => {
    const target = await createTestUser();
    const actor = await createTestUser();
    await setUserRole(actor.id, "moderator");
    const moderator = await freshSessionFor(actor);
    const reporter = await createTestUser();
    await db
      .insert(report)
      .values({ reporterId: reporter.id, targetType: "user", targetId: target.id, reason: "spam" });
    const resolve = () =>
      call(
        appRouter.moderation.resolve,
        {
          targetType: "user",
          targetId: target.id,
          outcome: "dismissed",
        },
        { context: contextFor(moderator) },
      );
    await db.run(sql`create trigger reject_report_stamp_test before update on report
      when new.resolved_at is not null
      begin select raise(abort, 'injected report resolution failure'); end`);
    try {
      await expect(resolve()).rejects.toThrow();
    } finally {
      await db.run(sql`drop trigger reject_report_stamp_test`);
    }
    expect((await db.select().from(report))[0].resolvedAt).toBeNull();
    expect(await db.select().from(moderationAction)).toHaveLength(0);
    expect(vi.mocked(testEmailSender.send)).not.toHaveBeenCalled();
    const results = await Promise.allSettled([resolve(), resolve()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "BAD_REQUEST" },
    });
    const actions = await db.select().from(moderationAction);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: "case_resolved",
      details: { outcome: "dismissed", reporterCount: 1 },
    });
    expect(vi.mocked(testEmailSender.send)).toHaveBeenCalledTimes(1);
  });

  it("a failed ban preserves active sessions, open reports, account state and notification history", async () => {
    const target = await createTestUser();
    const actor = await createTestUser();
    await setUserRole(actor.id, "admin");
    const reporter = await createTestUser();
    const sessions = await db.select().from(session).where(eq(session.userId, target.id));
    expect(sessions.length).toBeGreaterThan(0);
    await db
      .insert(report)
      .values({ reporterId: reporter.id, targetType: "user", targetId: target.id, reason: "spam" });
    const ban = () =>
      banUser(anonContext, {
        userId: target.id,
        actorId: actor.id,
        actorRole: "admin",
        reason: "spam",
      });
    await db.run(sql`create trigger reject_ban_test before update on user
      when new.banned = 1
      begin select raise(abort, 'injected ban failure'); end`);
    try {
      await expect(ban()).rejects.toThrow();
    } finally {
      await db.run(sql`drop trigger reject_ban_test`);
    }
    expect((await db.select().from(user).where(eq(user.id, target.id)))[0].banned).toBe(false);
    expect(await db.select().from(session).where(eq(session.userId, target.id))).toEqual(sessions);
    expect((await db.select().from(report))[0].resolvedAt).toBeNull();
    expect(await db.select().from(moderationAction)).toHaveLength(0);
    expect(await db.select().from(notification)).toHaveLength(0);
    expect(vi.mocked(testEmailSender.send)).not.toHaveBeenCalled();
    await ban();
    expect(await db.select().from(session).where(eq(session.userId, target.id))).toHaveLength(0);
    expect((await db.select().from(report))[0].resolvedOutcome).toBe("actioned");
    expect(await db.select().from(moderationAction)).toHaveLength(1);
    expect(await db.select().from(notification)).toHaveLength(1);
    expect(vi.mocked(testEmailSender.send)).toHaveBeenCalledTimes(1);
  });

  it("supersedes only sanction appeals and reverses only the matching control family", async () => {
    const target = await createTestUser();
    const actor = await createTestUser();
    await setUserRole(actor.id, "admin");
    const args = { userId: target.id, actorId: actor.id, actorRole: "admin" };
    const openFor = async (code: string) => {
      const [action] = await db
        .select()
        .from(moderationAction)
        .where(
          and(eq(moderationAction.targetUserId, target.id), eq(moderationAction.action, code)),
        );
      const [opened] = await db
        .insert(appeal)
        .values({
          actionId: action.id,
          appellantId: target.id,
          tokenNonce: crypto.randomUUID(),
          reason: "Please review this action.",
        })
        .returning();
      return opened;
    };
    const expires = await suspendUser(anonContext, {
      ...args,
      reason: "First sentence",
      durationSeconds: 3600,
    });
    expect((await db.select().from(user).where(eq(user.id, target.id)))[0].banExpires).toEqual(
      expires,
    );
    const sanctionAppeal = await openFor("user_suspended");
    await setRole(anonContext, { ...args, role: "moderator" });
    const roleAppeal = await openFor("role_changed");
    await banUser(anonContext, { ...args, reason: "New sentence" });
    expect(
      (await db.select().from(appeal).where(eq(appeal.id, sanctionAppeal.id)))[0],
    ).toMatchObject({
      status: "superseded",
      reviewedAt: null,
      reviewedBy: null,
    });
    expect((await db.select().from(appeal).where(eq(appeal.id, roleAppeal.id)))[0].status).toBe(
      "open",
    );
    const banAppeal = await openFor("user_banned");
    await unbanUser(anonContext, args);
    expect((await db.select().from(appeal).where(eq(appeal.id, banAppeal.id)))[0]).toMatchObject({
      status: "reversed",
      reviewedAt: null,
      reviewedBy: null,
    });
    expect((await db.select().from(appeal).where(eq(appeal.id, roleAppeal.id)))[0].status).toBe(
      "open",
    );
    await setRole(anonContext, { ...args, role: "user" });
    expect((await db.select().from(appeal).where(eq(appeal.id, roleAppeal.id)))[0]).toMatchObject({
      status: "reversed",
      reviewedAt: null,
      reviewedBy: null,
    });
  });
});
