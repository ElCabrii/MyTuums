import { and, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { messageIdentity, messageRecovery, user, userBlock } from "@my-tuums/db/schema";
import { messageRecoveryEmail, localeFromRequest } from "@my-tuums/auth/email";
import { identitySchema, publicKeySchema, validateIdentity } from "@my-tuums/message-crypto";
import { z } from "zod";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

const recoveryRequestPolicy = { name: "messageRecoveryRequest", limit: 3, windowMs: 3_600_000 };
const recoveryAttemptPolicy = { name: "messageRecoveryAttempt", limit: 10, windowMs: 3_600_000 };
const registrationPolicy = { name: "messageKeyRegistration", limit: 5, windowMs: 3_600_000 };

async function codeDigest(id: string, code: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${id}:${code}`);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function unavailable(): never {
  throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Encrypted messaging is unavailable." });
}

export const messageKeyRouter = {
  status: protectedProcedure.use(rateLimit(RATE_LIMITS.read)).handler(async ({ context }) => {
    const [own] = await context.db
      .select({ identity: messageIdentity.publicIdentity })
      .from(messageIdentity)
      .where(eq(messageIdentity.userId, context.user.id))
      .limit(1);
    return {
      recovery: context.messageRecoveryKeys?.active ?? null,
      identity: own ? identitySchema.parse(JSON.parse(own.identity)) : null,
    };
  }),

  identity: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({ userId: z.string().min(1).max(128) }))
    .handler(async ({ input, context }) => {
      const [row] = await context.db
        .select({ identity: messageIdentity.publicIdentity })
        .from(messageIdentity)
        .where(
          and(
            eq(messageIdentity.userId, input.userId),
            sql`not exists (
          select 1 from ${userBlock} where
          (${userBlock.blockerId} = ${context.user.id} and ${userBlock.blockedId} = ${input.userId}) or
          (${userBlock.blockerId} = ${input.userId} and ${userBlock.blockedId} = ${context.user.id})
        )`,
          ),
        )
        .limit(1);
      return row ? identitySchema.parse(JSON.parse(row.identity)) : null;
    }),

  register: protectedProcedure
    .use(rateLimit(registrationPolicy))
    .input(
      z.strictObject({
        identity: identitySchema,
        backup: z.string().min(1).max(8192),
        recoveryKeyId: z.string().min(1).max(64),
      }),
    )
    .handler(async ({ input, context }) => {
      const recovery = context.messageRecoveryKeys;
      if (!recovery) unavailable();
      if (input.identity.userId !== context.user.id || input.recoveryKeyId !== recovery.active.id) {
        throw new ORPCError("BAD_REQUEST", { message: "Encryption setup has changed. Try again." });
      }
      try {
        await validateIdentity(input.identity);
        await recovery.validateBackup(input.backup, input.identity);
      } catch {
        throw new ORPCError("BAD_REQUEST", { message: "Invalid encryption backup." });
      }
      const [inserted] = await context.db
        .insert(messageIdentity)
        .values({
          userId: context.user.id,
          publicIdentity: JSON.stringify(input.identity),
          backup: input.backup,
          recoveryKeyId: input.recoveryKeyId,
        })
        .onConflictDoNothing()
        .returning({ userId: messageIdentity.userId });
      if (!inserted)
        throw new ORPCError("CONFLICT", {
          message: "Messaging already has an encryption identity. Recover it instead.",
        });
      return { registered: true };
    }),

  requestRecovery: protectedProcedure
    .use(rateLimit(recoveryRequestPolicy))
    .input(z.strictObject({ transportKey: publicKeySchema }))
    .handler(async ({ input, context }) => {
      if (!context.messageRecoveryKeys) unavailable();
      const [account] = await context.db
        .select({ email: user.email, verified: user.emailVerified })
        .from(user)
        .where(eq(user.id, context.user.id))
        .limit(1);
      if (!account?.verified || !context.session)
        throw new ORPCError("FORBIDDEN", {
          message: "Verify your email before recovering messages.",
        });
      const [identity] = await context.db
        .select({ id: messageIdentity.userId })
        .from(messageIdentity)
        .where(eq(messageIdentity.userId, context.user.id))
        .limit(1);
      if (!identity) throw new ORPCError("NOT_FOUND");
      const id = crypto.randomUUID();
      const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      )
        .join("")
        .toUpperCase();
      const challenge = {
        id,
        userId: context.user.id,
        sessionId: context.session.session.id,
        email: account.email,
        codeHash: await codeDigest(id, code),
        transportKey: JSON.stringify(input.transportKey),
        expiresAt: new Date(Date.now() + 600_000),
        attempts: 0,
      };
      await context.db
        .insert(messageRecovery)
        .values(challenge)
        .onConflictDoUpdate({ target: messageRecovery.userId, set: challenge });
      try {
        await context.emailSender.send({
          to: account.email,
          ...(await messageRecoveryEmail(
            context.webOrigin,
            code,
            localeFromRequest(context.headers),
          )),
        });
      } catch {
        await context.db
          .delete(messageRecovery)
          .where(and(eq(messageRecovery.userId, context.user.id), eq(messageRecovery.id, id)));
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: "Recovery email could not be sent.",
        });
      }
      return { id };
    }),

  recover: protectedProcedure
    .use(rateLimit(recoveryAttemptPolicy))
    .input(z.strictObject({ id: z.uuid(), code: z.string().regex(/^[A-Fa-f0-9]{16}$/) }))
    .handler(async ({ input, context }) => {
      const recovery = context.messageRecoveryKeys;
      if (!recovery) unavailable();
      if (!context.session) throw new ORPCError("UNAUTHORIZED");
      const currentChallenge = and(
        eq(messageRecovery.userId, context.user.id),
        eq(messageRecovery.id, input.id),
        eq(messageRecovery.sessionId, context.session.session.id),
        sql`${messageRecovery.expiresAt} > cast(unixepoch('subsec') * 1000 as integer)`,
        sql`exists (select 1 from ${user} where ${user.id} = ${context.user.id} and ${user.email} = ${messageRecovery.email} and ${user.emailVerified} = 1)`,
      );
      // Both limits are database writes: concurrent attempts cannot bypass them.
      const [challenge] = await context.db
        .update(messageRecovery)
        .set({ attempts: sql`${messageRecovery.attempts} + 1` })
        .where(and(currentChallenge, sql`${messageRecovery.attempts} < 5`))
        .returning();
      const digest = await codeDigest(input.id, input.code.toUpperCase());
      if (!challenge || challenge.codeHash !== digest)
        throw new ORPCError("BAD_REQUEST", { message: "Invalid or expired recovery code." });
      const [consumed] = await context.db
        .delete(messageRecovery)
        .where(and(currentChallenge, eq(messageRecovery.codeHash, digest)))
        .returning({ transportKey: messageRecovery.transportKey });
      if (!consumed)
        throw new ORPCError("BAD_REQUEST", { message: "Invalid or expired recovery code." });
      const [identity] = await context.db
        .select()
        .from(messageIdentity)
        .where(eq(messageIdentity.userId, context.user.id))
        .limit(1);
      if (!identity) throw new ORPCError("NOT_FOUND");
      try {
        return {
          backup: await recovery.recover(
            identity.backup,
            identity.recoveryKeyId,
            identitySchema.parse(JSON.parse(identity.publicIdentity)),
            publicKeySchema.parse(JSON.parse(consumed.transportKey)),
          ),
        };
      } catch {
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: "Message recovery is unavailable. Request a new code to try again.",
        });
      }
    }),
};
