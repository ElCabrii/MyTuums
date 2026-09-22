import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { messageIdentity, messageRecovery, user } from "@my-tuums/db/schema";
import {
  createIdentity,
  decryptRecoveryBackup,
  encryptRecoveryBackup,
  publicIdentity,
} from "@my-tuums/message-crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appRouter } from "./router.js";
import { createMessageRecoveryKeys } from "./message-recovery-keys.js";
import {
  contextFor,
  createTestUser,
  testEmailSender,
  truncateAll,
  type TestUser,
} from "./testing/harness.js";
import { closeDb } from "./testing/runtime.js";

const recoveryIdentity = await createIdentity("recovery-test-only");
const recovery = createMessageRecoveryKeys(
  JSON.stringify({ active: "test", keys: { test: recoveryIdentity.encryption } }),
);
const context = (account: TestUser) => ({ ...contextFor(account), messageRecoveryKeys: recovery });
beforeAll(truncateAll);
afterAll(async () => {
  await truncateAll();
  await closeDb();
});

async function register() {
  const account = await createTestUser();
  const ctx = context(account);
  await ctx.db.update(user).set({ emailVerified: true }).where(eq(user.id, account.id));
  const identity = await createIdentity(account.id);
  const input = {
    identity: publicIdentity(identity),
    backup: await encryptRecoveryBackup(identity, recovery.active.publicKey),
    recoveryKeyId: recovery.active.id,
  };
  await call(appRouter.messageKey.register, input, { context: ctx });
  return { account, ctx, identity, input };
}

async function requestRecovery(account: TestUser) {
  const transport = await createIdentity(account.id);
  const result = await call(
    appRouter.messageKey.requestRecovery,
    { transportKey: publicIdentity(transport).encryption },
    { context: context(account) },
  );
  const mail = vi.mocked(testEmailSender.send).mock.calls.at(-1)?.[0];
  const code = mail?.text.match(/[A-F0-9]{16}/)?.[0];
  if (!code) throw new Error("Synthetic recovery email missing.");
  return { ...result, code, transport };
}

describe("message identity and email recovery", () => {
  it("keeps registration immutable, validates backups, and exposes only public identity material", async () => {
    const { account, ctx, identity, input } = await register();
    const status = await call(appRouter.messageKey.status, undefined, { context: ctx });
    expect(status.identity).toEqual(publicIdentity(identity));
    expect(JSON.stringify(status)).not.toContain(identity.encryption.d);
    await expect(
      call(appRouter.messageKey.register, input, { context: ctx }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const other = await createTestUser();
    await expect(
      call(appRouter.messageKey.register, input, { context: context(other) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ownOther = await createIdentity(other.id);
    await expect(
      call(
        appRouter.messageKey.register,
        { ...input, identity: publicIdentity(ownOther) },
        { context: context(other) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [stored] = await ctx.db
      .select()
      .from(messageIdentity)
      .where(eq(messageIdentity.userId, account.id));
    expect(stored.backup).not.toContain(identity.encryption.d);
  });

  it("recovers through email into only the requesting browser and consumes the code exactly once", async () => {
    const { account, ctx, identity } = await register();
    const request = await requestRecovery(account);
    const [stored] = await ctx.db
      .select()
      .from(messageRecovery)
      .where(eq(messageRecovery.userId, account.id));
    expect(JSON.stringify(stored)).not.toContain(request.code);
    const input = { id: request.id, code: request.code };
    const outcomes = await Promise.allSettled([
      call(appRouter.messageKey.recover, input, { context: ctx }),
      call(appRouter.messageKey.recover, input, { context: ctx }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const result = outcomes.find((entry) => entry.status === "fulfilled");
    if (!result || result.status !== "fulfilled") throw new Error("No recovery response.");
    const restored = await decryptRecoveryBackup(
      result.value.backup,
      request.transport.encryption,
      publicIdentity(identity),
    );
    expect(restored).toEqual(identity);
    const unrelatedBrowser = await createIdentity(account.id);
    await expect(
      decryptRecoveryBackup(
        result.value.backup,
        unrelatedBrowser.encryption,
        publicIdentity(identity),
      ),
    ).rejects.toThrow();
    await expect(call(appRouter.messageKey.recover, input, { context: ctx })).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
  });

  it("refuses another account, another session, expired codes, and email changes", async () => {
    const { account, ctx } = await register();
    const request = await requestRecovery(account);
    const input = { id: request.id, code: request.code };
    const other = await createTestUser();
    await expect(
      call(appRouter.messageKey.recover, input, { context: context(other) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const differentSession = {
      ...ctx,
      session: {
        ...account.session,
        session: { ...account.session.session, id: "different-session" },
      },
    };
    await expect(
      call(appRouter.messageKey.recover, input, { context: differentSession }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await ctx.db.update(user).set({ email: "changed@example.test" }).where(eq(user.id, account.id));
    await expect(call(appRouter.messageKey.recover, input, { context: ctx })).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
    await ctx.db
      .update(user)
      .set({ email: account.session.user.email })
      .where(eq(user.id, account.id));
    await ctx.db
      .update(messageRecovery)
      .set({ expiresAt: new Date(0) })
      .where(eq(messageRecovery.userId, account.id));
    await expect(call(appRouter.messageKey.recover, input, { context: ctx })).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
  });

  it("caps concurrent guesses and invalidates the previous code when a new one is requested", async () => {
    const { account, ctx } = await register();
    const first = await requestRecovery(account);
    const second = await requestRecovery(account);
    await expect(
      call(appRouter.messageKey.recover, { id: first.id, code: first.code }, { context: ctx }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const wrong = second.code === "0000000000000000" ? "1111111111111111" : "0000000000000000";
    await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        call(appRouter.messageKey.recover, { id: second.id, code: wrong }, { context: ctx }),
      ),
    );
    await expect(
      call(appRouter.messageKey.recover, { id: second.id, code: second.code }, { context: ctx }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [stored] = await ctx.db
      .select()
      .from(messageRecovery)
      .where(eq(messageRecovery.userId, account.id));
    expect(stored.attempts).toBe(5);
  });

  it("fails closed when recovery is unconfigured or delivery fails", async () => {
    const { account, ctx } = await register();
    const transport = await createIdentity(account.id);
    await expect(
      call(
        appRouter.messageKey.requestRecovery,
        { transportKey: publicIdentity(transport).encryption },
        { context: contextFor(account) },
      ),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    vi.mocked(testEmailSender.send).mockRejectedValueOnce(new Error("synthetic mail failure"));
    await expect(requestRecovery(account)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(
      await ctx.db.select().from(messageRecovery).where(eq(messageRecovery.userId, account.id)),
    ).toHaveLength(0);
  });
});
