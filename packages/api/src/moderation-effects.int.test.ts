import { randomUUID } from "node:crypto";
import { closeDb } from "@my-tuums/db";
import { and, eq } from "drizzle-orm";
import { moderationAction, post, postAttachment, report, session, user } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyModerationEffect,
  banUser,
  banUserEffect,
  removePost,
  removePostEffect,
  restorePost,
  restoreRoleEffect,
  setRole,
  setRoleEffect,
  suspendUser,
  suspendUserEffect,
  unbanUser,
  type DbLike,
} from "./moderation-actions.js";
import {
  anonContext,
  createTestUser,
  setUserBan,
  setUserRole,
  testEmailSender,
  truncateAll,
} from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/** A direct post insert for content-controlled fixtures. */
async function seedPost(authorId: string, content: string): Promise<string> {
  const [row] = await anonContext.db
    .insert(post)
    .values({ authorId, content })
    .returning({ id: post.id });
  return row.id;
}

/**
 * A `DbLike` whose `transaction` runs the callback against the REAL database
 * and then throws — every write the effect made inside its transaction is
 * rolled back, exactly as a mid-transaction failure would. This is how the
 * tests force a failure AFTER the writes, so the rollback guarantees (no
 * audit row, no partial state, no email) are exercised rather than assumed.
 */
function dbThatRollsBack(): DbLike {
  const real = anonContext.db;
  return {
    select: real.select.bind(real),
    insert: real.insert.bind(real),
    update: real.update.bind(real),
    delete: real.delete.bind(real),
    execute: real.execute.bind(real),
    transaction: async (callback) =>
      real.transaction(async (tx) => {
        await callback(tx);
        throw new Error("simulated failure after writes, before commit");
      }),
  };
}

describe("forward moderation effects", () => {
  it("removePostEffect describes the removed post's images, and drops the quote block when there is no text", async () => {
    const author = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");

    async function noticeFor(content: string, images: number) {
      const [row] = await anonContext.db
        .insert(post)
        .values({ authorId: author.id, content })
        .returning({ id: post.id });
      for (let position = 0; position < images; position += 1) {
        await anonContext.db.insert(postAttachment).values({
          postId: row.id,
          position,
          mediaPath: `/media/posts/${author.id}/${row.id}/${randomUUID()}.png`,
          contentType: "image/png",
          byteSize: 24,
          width: 64,
          height: 64,
        });
      }
      const { pending } = await removePostEffect(anonContext.db, {
        postId: row.id,
        actorId: mod.id,
        reason: "spam content",
      });
      return { en: pending[0].build("en").text, fr: pending[0].build("fr").text };
    }

    // Issue #202: an image-only post stores `content` as "", which quoted
    // verbatim would read as an empty pair of quotes. The count is what the
    // author can recognise the post by instead.
    const imageOnly = await noticeFor("", 1);
    expect(imageOnly.en).toContain("Your post: 1 image, no text.");
    expect(imageOnly.en).not.toContain('""');
    expect(imageOnly.fr).toContain("Votre publication : 1 image, sans texte.");
    expect(imageOnly.fr).not.toContain("«  »");

    const both = await noticeFor("look at these", 2);
    expect(both.en).toContain('Your post (2 images):\n"look at these"');
    expect(both.fr).toContain("Votre publication (2 images) :\n« look at these »");
  });

  it("removePostEffect commits the tombstone, the report stamps and the audit row, and returns the notice unsent", async () => {
    const author = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");
    const reporter = await createTestUser();
    const postId = await seedPost(author.id, "remove me");

    await anonContext.db.insert(report).values({
      reporterId: reporter.id,
      targetType: "post",
      targetId: postId,
      reason: "spam",
    });

    const { pending } = await removePostEffect(anonContext.db, {
      postId,
      actorId: mod.id,
      reason: "spam content",
    });

    // The effect itself sends nothing — the notice is owed, not sent.
    expect(vi.mocked(testEmailSender.send)).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    expect(pending[0].userId).toBe(author.id);
    expect(pending[0].build("en").subject).toBe("Your post was removed from MyTuums");
    // A text-only post is quoted with no image count at all.
    expect(pending[0].build("en").text).toContain('Your post:\n"remove me"');
    expect(pending[0].build("fr").text).toContain("Votre publication :\n« remove me »");

    const [row] = await anonContext.db
      .select({
        removedAt: post.removedAt,
        removedBy: post.removedBy,
        removedReason: post.removedReason,
      })
      .from(post)
      .where(eq(post.id, postId));
    expect(row?.removedAt).not.toBeNull();
    expect(row?.removedBy).toBe(mod.id);
    expect(row?.removedReason).toBe("spam content");

    const [stamped] = await anonContext.db
      .select({ resolvedOutcome: report.resolvedOutcome, resolvedBy: report.resolvedBy })
      .from(report)
      .where(eq(report.reporterId, reporter.id));
    expect(stamped?.resolvedOutcome).toBe("actioned");
    expect(stamped?.resolvedBy).toBe(mod.id);

    const [action] = await anonContext.db
      .select({ reason: moderationAction.reason })
      .from(moderationAction)
      .where(
        and(eq(moderationAction.action, "post_removed"), eq(moderationAction.targetPostId, postId)),
      );
    expect(action?.reason).toBe("spam content");
  });

  it("a failure inside the transaction rolls back the tombstone, the stamps and the audit row — and no email is owed", async () => {
    const author = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");
    const reporter = await createTestUser();
    const postId = await seedPost(author.id, "roll me back");

    await anonContext.db.insert(report).values({
      reporterId: reporter.id,
      targetType: "post",
      targetId: postId,
      reason: "spam",
    });

    await expect(
      removePostEffect(dbThatRollsBack(), {
        postId,
        actorId: mod.id,
        reason: "spam content",
      }),
    ).rejects.toThrow("simulated failure after writes, before commit");

    const [row] = await anonContext.db
      .select({ removedAt: post.removedAt })
      .from(post)
      .where(eq(post.id, postId));
    expect(row?.removedAt).toBeNull();

    const [stamped] = await anonContext.db
      .select({ resolvedAt: report.resolvedAt })
      .from(report)
      .where(eq(report.reporterId, reporter.id));
    expect(stamped?.resolvedAt).toBeNull();

    const actions = await anonContext.db
      .select({ id: moderationAction.id })
      .from(moderationAction)
      .where(
        and(eq(moderationAction.action, "post_removed"), eq(moderationAction.targetPostId, postId)),
      );
    expect(actions).toHaveLength(0);

    expect(vi.mocked(testEmailSender.send)).not.toHaveBeenCalled();
  });

  it("setRoleEffect rolls back the role write and its audit row together", async () => {
    const admin = await createTestUser();
    await setUserRole(admin.id, "admin");
    const bob = await createTestUser();

    await expect(
      setRoleEffect(dbThatRollsBack(), {
        userId: bob.id,
        actorId: admin.id,
        actorRole: "admin",
        role: "moderator",
      }),
    ).rejects.toThrow("simulated failure after writes, before commit");

    const [row] = await anonContext.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, bob.id));
    expect(row?.role).toBe("user");

    const actions = await anonContext.db
      .select({ id: moderationAction.id })
      .from(moderationAction)
      .where(
        and(eq(moderationAction.action, "role_changed"), eq(moderationAction.targetUserId, bob.id)),
      );
    expect(actions).toHaveLength(0);
  });

  it("restoreRoleEffect is a no-op when the contested grant no longer holds — a newer setRole wins, no audit row lies about it", async () => {
    const admin = await createTestUser();
    await setUserRole(admin.id, "admin");
    const bob = await createTestUser();
    await setUserRole(bob.id, "staff");

    // The appeal contests the staff grant; before the overturn commits, an
    // admin promotes bob to admin. The grant no longer holds, so the
    // restore must not clobber the newer role or log a row describing a
    // restore that never happened.
    await setUserRole(bob.id, "admin");

    const pending = await restoreRoleEffect(anonContext.db, {
      userId: bob.id,
      actorId: admin.id,
      actorRole: "admin",
      grantedRole: "staff",
      oldRole: "user",
    });

    expect(pending.pending).toEqual([]);

    const [row] = await anonContext.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, bob.id));
    expect(row?.role).toBe("admin");

    const actions = await anonContext.db
      .select({ id: moderationAction.id })
      .from(moderationAction)
      .where(
        and(eq(moderationAction.action, "role_changed"), eq(moderationAction.targetUserId, bob.id)),
      );
    expect(actions).toHaveLength(0);
  });

  it("restoreRoleEffect restores the contested role and returns the notice when the grant still holds", async () => {
    const admin = await createTestUser();
    await setUserRole(admin.id, "admin");
    const bob = await createTestUser();
    await setUserRole(bob.id, "staff");

    const pending = await restoreRoleEffect(anonContext.db, {
      userId: bob.id,
      actorId: admin.id,
      actorRole: "admin",
      grantedRole: "staff",
      oldRole: "user",
    });

    expect(pending.pending).toHaveLength(1);
    expect(pending.pending[0].userId).toBe(bob.id);
    expect(pending.pending[0].build("en").subject).toBe("Your MyTuums role changed");

    const [row] = await anonContext.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, bob.id));
    expect(row?.role).toBe("user");

    const [action] = await anonContext.db
      .select({ details: moderationAction.details })
      .from(moderationAction)
      .where(
        and(eq(moderationAction.action, "role_changed"), eq(moderationAction.targetUserId, bob.id)),
      );
    expect(action?.details).toEqual({ oldRole: "staff", newRole: "user" });
  });

  it("an overturn racing a concurrent setRole can never clobber the newer role — the promotion always wins the row lock", async () => {
    const admin = await createTestUser();
    await setUserRole(admin.id, "admin");
    const bob = await createTestUser();
    await setUserRole(bob.id, "staff");

    // Two effects on the same row, started together. The row lock
    // serializes their guard reads, and either order is safe: if the
    // restore wins the lock first it restores and the promotion then
    // supersedes it; if the promotion wins first the restore observes the
    // committed grant no longer holding and no-ops. The final role is the
    // newer sentence in every interleaving — the overturn can never
    // clobber it.
    await Promise.all([
      setRoleEffect(anonContext.db, {
        userId: bob.id,
        actorId: admin.id,
        actorRole: "admin",
        role: "admin",
      }),
      restoreRoleEffect(anonContext.db, {
        userId: bob.id,
        actorId: admin.id,
        actorRole: "admin",
        grantedRole: "staff",
        oldRole: "user",
      }),
    ]);

    const [row] = await anonContext.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, bob.id));
    expect(row?.role).toBe("admin");
  });

  it("suspendUserEffect commits the ban, the session sweep and the audit row, returning the stored expiry", async () => {
    const victim = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");

    const { banExpires, pending } = await suspendUserEffect(anonContext.db, {
      userId: victim.id,
      actorId: mod.id,
      actorRole: "moderator",
      reason: "spam",
      durationSeconds: 3600,
    });

    const [row] = await anonContext.db
      .select({ banned: user.banned, banExpires: user.banExpires })
      .from(user)
      .where(eq(user.id, victim.id));
    expect(row?.banned).toBe(true);
    expect(row?.banExpires).toEqual(banExpires);

    const sessions = await anonContext.db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, victim.id));
    expect(sessions).toHaveLength(0);

    const [action] = await anonContext.db
      .select({ details: moderationAction.details })
      .from(moderationAction)
      .where(
        and(
          eq(moderationAction.action, "user_suspended"),
          eq(moderationAction.targetUserId, victim.id),
        ),
      );
    expect(action?.details).toEqual({ durationSeconds: 3600 });

    expect(pending).toHaveLength(1);
    expect(pending[0].build("en").subject).toBe("Your account was suspended");
    expect(vi.mocked(testEmailSender.send)).not.toHaveBeenCalled();
  });

  it("banUserEffect commits the permanent ban and returns the notice", async () => {
    const victim = await createTestUser();
    const staff = await createTestUser();
    await setUserRole(staff.id, "staff");

    const { pending } = await banUserEffect(anonContext.db, {
      userId: victim.id,
      actorId: staff.id,
      actorRole: "staff",
      reason: "permanent spam",
    });

    const [row] = await anonContext.db
      .select({ banned: user.banned, banExpires: user.banExpires })
      .from(user)
      .where(eq(user.id, victim.id));
    expect(row?.banned).toBe(true);
    expect(row?.banExpires).toBeNull();
    expect(pending).toHaveLength(1);
    expect(pending[0].build("en").subject).toBe("Your account was banned");
  });
});

describe("applyModerationEffect", () => {
  it("sends the effect's notice after its commit — and a dead email adapter is swallowed, the action stands", async () => {
    const author = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");
    const postId = await seedPost(author.id, "email may fail");

    vi.mocked(testEmailSender.send).mockRejectedValueOnce(new Error("resend is down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      removePost(anonContext, {
        postId,
        actorId: mod.id,
        reason: "spam",
      }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(testEmailSender.send)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(testEmailSender.send).mock.calls[0][0].subject).toBe(
      "Your post was removed from MyTuums",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Moderation email failed to send/),
      expect.anything(),
      expect.any(Error),
    );

    // The removal committed before the send — the failed adapter changes
    // nothing about the action.
    const [row] = await anonContext.db
      .select({ removedAt: post.removedAt })
      .from(post)
      .where(eq(post.id, postId));
    expect(row?.removedAt).not.toBeNull();
    errorSpy.mockRestore();
  });

  it("an effect that rolls back produces no audit row and no email", async () => {
    const author = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");
    const postId = await seedPost(author.id, "roll me back");

    // The runner opens the transaction and hands the effect the transaction
    // handle; the effect runs inside it and then throws, so the runner's
    // transaction rolls back — the removal, the audit row and the send all
    // vanish together.
    await expect(
      applyModerationEffect(anonContext, async (db) => {
        const { pending } = await removePostEffect(db, {
          postId,
          actorId: mod.id,
          reason: "spam content",
        });
        expect(pending).toHaveLength(1);
        throw new Error("simulated failure after writes, before commit");
      }),
    ).rejects.toThrow("simulated failure after writes, before commit");

    const [row] = await anonContext.db
      .select({ removedAt: post.removedAt })
      .from(post)
      .where(eq(post.id, postId));
    expect(row?.removedAt).toBeNull();

    const actions = await anonContext.db
      .select({ id: moderationAction.id })
      .from(moderationAction)
      .where(
        and(eq(moderationAction.action, "post_removed"), eq(moderationAction.targetPostId, postId)),
      );
    expect(actions).toHaveLength(0);

    expect(vi.mocked(testEmailSender.send)).not.toHaveBeenCalled();
  });
});

describe("the moderation entry points deliver their notices", () => {
  it("removePost delivers its removal notice", async () => {
    const author = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");
    const postId = await seedPost(author.id, "remove <script>alert('x')</script>");

    await removePost(anonContext, { postId, actorId: mod.id, reason: "spam & scams" });

    const email = vi
      .mocked(testEmailSender.send)
      .mock.calls.map(([mail]) => mail)
      .find((mail) => mail.subject === "Your post was removed from MyTuums");
    if (!email) throw new Error("expected the removal email to be delivered");

    const appealUrl = email.text.match(/https?:\/\/\S+/)?.[0];
    if (!appealUrl) throw new Error("expected the text fallback to contain an appeal URL");

    // HTML escapes attribute values, so the URL's `&` separators appear as
    // `&amp;`; compare in the escaped form so extra query params cannot break
    // this on an unrelated change.
    expect(email.html).toContain(appealUrl.replaceAll("&", "&amp;"));
    expect(email.html).toContain("/mytuums-192.png");
    expect(email.html).toContain("remove &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(email.html).not.toContain("<script>alert('x')</script>");
    expect(email.text).toContain("spam & scams");
  });

  it("removePost delivers branded French HTML from the recipient's stored locale", async () => {
    const author = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");
    await anonContext.db.update(user).set({ localePreference: "fr" }).where(eq(user.id, author.id));
    const postId = await seedPost(author.id, "publication en français");

    await removePost(anonContext, { postId, actorId: mod.id, reason: "contenu indésirable" });

    const email = vi.mocked(testEmailSender.send).mock.calls[0]?.[0];
    if (!email) throw new Error("expected the French removal email to be delivered");
    expect(email.subject).toBe("Votre publication a été retirée de MyTuums");
    expect(email.text).toContain("Motif : contenu indésirable");
    expect(email.html).toContain('<html lang="fr">');
    expect(email.html).toContain("Un modérateur a retiré votre publication.");
  });

  it("restorePost delivers its restore notice", async () => {
    const author = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");
    const postId = await seedPost(author.id, "restore me");
    await removePost(anonContext, { postId, actorId: mod.id, reason: "spam" });

    await restorePost(anonContext, { postId, actorId: mod.id });

    const emails = vi.mocked(testEmailSender.send).mock.calls.map(([mail]) => mail.subject);
    expect(emails).toContain("Your post was restored");
  });

  it("suspendUser delivers its suspension notice and returns the stored expiry", async () => {
    const victim = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");

    const banExpires = await suspendUser(anonContext, {
      userId: victim.id,
      actorId: mod.id,
      actorRole: "moderator",
      reason: "spam",
      durationSeconds: 3600,
    });

    expect(banExpires).toBeInstanceOf(Date);
    const emails = vi.mocked(testEmailSender.send).mock.calls.map(([mail]) => mail.subject);
    expect(emails).toContain("Your account was suspended");
  });

  it("banUser delivers its ban notice", async () => {
    const victim = await createTestUser();
    const staff = await createTestUser();
    await setUserRole(staff.id, "staff");

    await banUser(anonContext, {
      userId: victim.id,
      actorId: staff.id,
      actorRole: "staff",
      reason: "permanent spam",
    });

    const emails = vi.mocked(testEmailSender.send).mock.calls.map(([mail]) => mail.subject);
    expect(emails).toContain("Your account was banned");
  });

  it("setRole delivers its role-change notice", async () => {
    const admin = await createTestUser();
    await setUserRole(admin.id, "admin");
    const bob = await createTestUser();

    await setRole(anonContext, {
      userId: bob.id,
      actorId: admin.id,
      actorRole: "admin",
      role: "moderator",
    });

    const emails = vi.mocked(testEmailSender.send).mock.calls.map(([mail]) => mail.subject);
    expect(emails).toContain("Your MyTuums role changed");
  });

  it("the direct inverse effects still deliver (unbanUser) and a no-op inverse sends nothing", async () => {
    const target = await createTestUser();
    await setUserBan(target.id, { reason: "permanent spam", expiresAt: null });
    const staff = await createTestUser();
    await setUserRole(staff.id, "staff");

    await unbanUser(anonContext, {
      userId: target.id,
      actorId: staff.id,
      actorRole: "staff",
    });

    const emails = vi.mocked(testEmailSender.send).mock.calls.map(([mail]) => mail.subject);
    expect(emails).toContain("Your account is no longer banned");

    // The no-op half: restoring a post that was never removed owes no email —
    // the inverse effect returns an empty pending list and the runner sends
    // nothing.
    const author = await createTestUser();
    const mod = await createTestUser();
    await setUserRole(mod.id, "moderator");
    const postId = await seedPost(author.id, "never removed");

    await restorePost(anonContext, { postId, actorId: mod.id });

    const afterNoOp = vi.mocked(testEmailSender.send).mock.calls.map(([mail]) => mail.subject);
    expect(afterNoOp).not.toContain("Your post was restored");
  });
});
