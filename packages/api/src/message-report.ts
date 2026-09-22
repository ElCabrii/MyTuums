import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import {
  conversation,
  conversationParticipant,
  message,
  messageIdentity,
  report,
  user,
} from "@my-tuums/db/schema";
import { identitySchema, verifyDisclosedMessage } from "@my-tuums/message-crypto";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

/**
 * The evidence half of reporting a private message (issue #408).
 *
 * A DM report is judged on an exchange, not a sentence: harassment is
 * two-way, so the snapshot the reporter submits carries the reported message
 * plus a bounded window of the messages before it. It is the reporter's own
 * evidence — immune to the sender later deleting the message — exactly like a
 * post report's content snapshot (issue #264), and it is the ONLY way
 * moderators ever see DM content: there is deliberately no live browse
 * surface for conversations (docs/security.md).
 *
 * The shape is versioned so a future report format can be told apart from
 * this one when it renders.
 */

/** How many messages precede the reported one in the snapshot. */
export const MESSAGE_REPORT_CONTEXT = 10;

/** The stored snapshot: reported message plus its context window, oldest first. */
export const messageReportSnapshot = z.object({
  version: z.literal(1),
  reportedMessageId: z.uuid(),
  messages: z.array(
    z.object({
      id: z.uuid(),
      senderId: z.string().min(1),
      /** The sender's handle when the snapshot was taken; null never renders. */
      senderHandle: z.string().nullable(),
      /** The retained body — read regardless of any later deletion. */
      body: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
});

export type MessageReportSnapshot = z.infer<typeof messageReportSnapshot>;

/**
 * Encrypted reports contain only the participant-disclosed, signature-verified
 * message. Legacy reports contain the message itself plus up to
 * `MESSAGE_REPORT_CONTEXT` messages before it in the thread's keyset order,
 * reversed to reading order (oldest first) so the case view renders the
 * exchange top-down. Null when the message does not exist.
 *
 * The caller authorizes FIRST (the reporter must be a participant of the
 * conversation — see `moderation.report`); this read is the evidence.
 */
export async function buildMessageReportSnapshot(
  db: Database,
  messageId: string,
  disclosure?: string,
): Promise<MessageReportSnapshot | null> {
  const [target] = await db
    .select({
      conversationId: message.conversationId,
      createdAt: message.createdAt,
      envelope: message.envelope,
      senderId: message.senderId,
    })
    .from(message)
    .where(eq(message.id, messageId))
    .limit(1);
  if (!target) return null;

  if (target.envelope !== null) {
    if (!disclosure)
      throw new ORPCError("BAD_REQUEST", {
        message: "Choose the message text to disclose with this report.",
      });
    const [sender] = await db
      .select({ identity: messageIdentity.publicIdentity, handle: user.username })
      .from(messageIdentity)
      .innerJoin(user, eq(user.id, messageIdentity.userId))
      .where(eq(messageIdentity.userId, target.senderId))
      .limit(1);
    const [pair] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, target.conversationId))
      .limit(1);
    if (!sender || !pair) return null;
    try {
      const verified = await verifyDisclosedMessage(
        disclosure,
        identitySchema.parse(JSON.parse(sender.identity)),
      );
      const recipientId = pair.userAId === target.senderId ? pair.userBId : pair.userAId;
      if (verified.id !== messageId || verified.recipientId !== recipientId)
        throw new Error("Incorrect report target.");
      return {
        version: 1,
        reportedMessageId: messageId,
        messages: [
          {
            id: messageId,
            senderId: target.senderId,
            senderHandle: sender.handle,
            body: verified.body,
            createdAt: target.createdAt.toISOString(),
          },
        ],
      };
    } catch {
      throw new ORPCError("BAD_REQUEST", { message: "Message evidence could not be verified." });
    }
  }

  const rows = await db
    .select({
      id: message.id,
      senderId: message.senderId,
      senderHandle: user.username,
      body: message.body,
      createdAt: message.createdAt,
    })
    .from(message)
    .innerJoin(user, eq(user.id, message.senderId))
    .where(
      and(
        eq(message.conversationId, target.conversationId),
        isNull(message.envelope),
        sql`(${message.createdAt}, ${message.id}) <= (${sql.param(target.createdAt, message.createdAt)}, ${messageId})`,
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(MESSAGE_REPORT_CONTEXT + 1);

  return {
    version: 1,
    reportedMessageId: messageId,
    messages: rows.reverse().map((row) => ({
      id: row.id,
      senderId: row.senderId,
      senderHandle: row.senderHandle,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Parses a stored snapshot; null when the row predates the format or corrupts. */
export function parseMessageReportSnapshot(raw: string | null): MessageReportSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = messageReportSnapshot.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Who a resolved message case is recorded against: the reported message's
 * sender. The live row first; when the message (or its sender's account) is
 * gone, the reports' own snapshots keep the sender's id — evidence survives
 * deletion, and so does attribution.
 *
 * Used by `moderation.resolve`: the audit trail names the account that
 * misbehaved, never the message itself (there is deliberately no per-message
 * removal power; the message link rides the action's `details`).
 */
export async function messageCaseSender(db: Database, messageId: string): Promise<string | null> {
  const [live] = await db
    .select({ senderId: message.senderId })
    .from(message)
    .where(eq(message.id, messageId))
    .limit(1);
  if (live) return live.senderId;

  const [newest] = await db
    .select({ snapshotContent: report.snapshotContent })
    .from(report)
    .where(and(eq(report.targetType, "message"), eq(report.targetId, messageId)))
    .orderBy(desc(report.createdAt))
    .limit(1);
  const snapshot = parseMessageReportSnapshot(newest?.snapshotContent ?? null);
  return snapshot?.messages.find((row) => row.id === snapshot.reportedMessageId)?.senderId ?? null;
}

/**
 * Whether `userId` participates in the conversation of `messageId` — the
 * authorization for reporting it. Both statuses count: hiding the
 * conversation (or blocking the sender) must not stand in the way of
 * reporting the exchange that caused it.
 */
export function messageParticipationExists(userId: string) {
  return sql`exists (select 1 from ${conversationParticipant}
    where ${conversationParticipant.conversationId} = ${message.conversationId}
      and ${conversationParticipant.userId} = ${userId})`;
}
