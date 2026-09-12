import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { EmailDeliveryError, type EmailLocale } from "@my-tuums/auth/email";
import type { Database } from "@my-tuums/db";
import { moderationEmail, user } from "@my-tuums/db/schema";
import type { Context } from "./context.js";
import { moderationEmailContent, renderModerationEmail } from "./moderation-email-content.js";

const clock = sql`cast(unixepoch('subsec') * 1000 as integer)`;
const leaseExpired = or(
  isNull(moderationEmail.leaseUntil),
  sql`${moderationEmail.leaseUntil} <= ${clock}`,
);
const due = and(
  isNull(moderationEmail.failedAt),
  sql`${moderationEmail.nextAttemptAt} <= ${clock}`,
  sql`${moderationEmail.expiresAt} > ${clock}`,
  sql`${moderationEmail.attempts} < 6`,
  leaseExpired,
  // Earlier unfinished notices for this recipient retain their place even
  // while backing off or held by another sender. Other recipients are independent.
  sql`not exists (select 1 from moderation_email earlier
    where earlier.user_id = moderation_email.user_id
      and earlier.sequence < moderation_email.sequence
      and earlier.failed_at is null and earlier.expires_at > ${clock})`,
);

/** Insert with the action's statements, using the same committed eligibility guard. */
export function moderationEmailInsert(
  db: Database,
  notice: {
    sourceId: string;
    recipients: SQL;
    content: SQL;
    fallbackLocale: EmailLocale;
  },
  when: SQL,
) {
  // INSERT SELECT follows the schema order. Each recipient is selected once,
  // including case resolutions that collect recipients from multiple reports.
  return db.insert(moderationEmail).select(sql`select null, lower(hex(randomblob(16))),
    ${notice.sourceId}, ${user.id},
    case when ${user.localePreference} in ('en','fr') then ${user.localePreference}
      else ${notice.fallbackLocale} end,
    ${notice.content}, 0, ${clock}, null, null, null, ${clock}, ${clock} + 86400000
    from ${user} where ${user.id} in (${notice.recipients}) and ${when}`);
}

type DeliveryContext = Pick<
  Context,
  "db" | "emailSender" | "webOrigin" | "appealToken" | "requestId"
>;

/** A new invocation can recover committed notices after the original request disappears. */
export async function deliverModerationEmails(context: DeliveryContext, sourceId?: string) {
  const { db } = context;
  const result = { sent: 0, retry: 0, failed: 0 };
  try {
    const candidates = await db
      .select({ id: moderationEmail.id })
      .from(moderationEmail)
      .where(and(due, sourceId === undefined ? undefined : eq(moderationEmail.sourceId, sourceId)))
      .orderBy(asc(moderationEmail.nextAttemptAt), asc(moderationEmail.sequence))
      .limit(25);
    for (const candidate of candidates) {
      const leaseId = crypto.randomUUID();
      const [notice] = await db
        .update(moderationEmail)
        .set({
          leaseId,
          leaseUntil: sql`${clock} + 120000`,
          attempts: sql`${moderationEmail.attempts} + 1`,
        })
        .where(and(eq(moderationEmail.id, candidate.id), due))
        .returning();
      if (!notice) continue;
      const owned = and(eq(moderationEmail.id, notice.id), eq(moderationEmail.leaseId, leaseId));
      const [recipient] = await db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, notice.userId));
      // The recipient FK removes pending private content with a deleted account.
      if (!recipient) continue;
      let sent = false;
      let retry = false;
      try {
        const content = moderationEmailContent.parse(notice.content);
        const email = await renderModerationEmail(content, {
          webOrigin: context.webOrigin,
          locale: notice.locale,
          async appealUrl() {
            const token = await context.appealToken.sign({
              purpose: "appeal",
              actionId: notice.sourceId,
              userId: notice.userId,
              nonce: notice.id,
              iat: Math.floor(notice.createdAt.getTime() / 1000),
            });
            return `${context.webOrigin}/appeal?token=${token}`;
          },
        });
        await context.emailSender.send({ to: recipient.email, ...email });
        sent = true;
      } catch (error) {
        retry = error instanceof EmailDeliveryError && error.retryable && notice.attempts < 6;
      }
      if (sent) {
        // Fencing also covers a slow sender completing after another lease began.
        await db.delete(moderationEmail).where(owned);
        result.sent += 1;
      } else {
        await db
          .update(moderationEmail)
          .set({
            leaseId: null,
            leaseUntil: null,
            nextAttemptAt: sql`${clock} + ${60_000 * 2 ** (notice.attempts - 1)}`,
            failedAt: retry ? null : sql`${clock}`,
          })
          .where(owned);
        if (retry) result.retry += 1;
        else result.failed += 1;
        console.error({ event: "moderation_email_failed", requestId: context.requestId });
      }
    }
  } catch {
    // A failed queue read/acknowledgement cannot undo an already committed action.
    // Unacknowledged claims remain recoverable after their lease expires.
    console.error({ event: "moderation_email_failed", requestId: context.requestId });
  }
  return result;
}

/** Bound retention and retire repeated interrupted attempts without sending stale notices. */
export async function cleanupModerationEmails(db: Database) {
  const expired = db
    .select({ id: moderationEmail.id })
    .from(moderationEmail)
    .where(sql`${moderationEmail.expiresAt} <= ${clock}`)
    .limit(100);
  const removed = await db
    .delete(moderationEmail)
    .where(sql`${moderationEmail.id} in (${expired})`)
    .returning({ id: moderationEmail.id });
  const exhausted = db
    .select({ id: moderationEmail.id })
    .from(moderationEmail)
    .where(
      and(isNull(moderationEmail.failedAt), sql`${moderationEmail.attempts} >= 6`, leaseExpired),
    )
    .limit(100);
  const failed = await db
    .update(moderationEmail)
    .set({ failedAt: sql`${clock}`, leaseId: null, leaseUntil: null })
    .where(sql`${moderationEmail.id} in (${exhausted})`)
    .returning({ id: moderationEmail.id });
  return { removed: removed.length, failed: failed.length };
}
