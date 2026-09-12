import { eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { localeFromRequest, type EmailLocale } from "@my-tuums/auth";
import type { Database } from "@my-tuums/db";
import { post } from "@my-tuums/db/schema";
import type { Context } from "./context.js";
import { moderateUser } from "./moderation-user.js";
import {
  moderatePost,
  withdrawDeletedPostAppeals,
  POST_AUTHOR_DELETED_MESSAGE,
} from "./moderation-post.js";
import { deliverModerationEmails } from "./moderation-email.js";
import type { UserRole } from "./roles.js";
import type { ModerationActionCode } from "./constants.js";
export { POST_AUTHOR_DELETED_MESSAGE } from "./moderation-post.js";
export {
  APPEALABLE_ACTIONS,
  INVERSE_ACTION,
  MODERATION_ACTION_CODES,
  type ModerationActionCode,
} from "./constants.js";

export type DbLike = Database;
type AppealContext = Pick<Context, "db" | "appealToken" | "webOrigin" | "headers">;
type EffectContext = Pick<
  Context,
  "db" | "headers" | "emailSender" | "webOrigin" | "requestId" | "appealToken"
>;

/** A durable notice reference; immediate delivery is optional after commit. */
export type PendingEmail = { sourceId: string; userId: string };

export interface ActionRow {
  id: string;
  action: ModerationActionCode;
  actorId: string | null;
  targetType: "post" | "user";
  targetPostId: string | null;
  targetUserId: string | null;
  createdAt: Date;
  details: unknown;
}

export async function makeAppealUrl(
  context: Pick<Context, "appealToken" | "webOrigin">,
  actionId: string,
  userId: string,
): Promise<string> {
  const token = await context.appealToken.sign({
    purpose: "appeal",
    actionId,
    userId,
    nonce: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
  });
  return `${context.webOrigin}/appeal?token=${token}`;
}

/** State, audit, notifications and email content commit in one guarded D1 batch. */
export async function removePostEffect(
  context: AppealContext,
  args: { postId: string; actorId: string; reason: string },
  closeAppeals = false,
): Promise<{ pending: PendingEmail[] }> {
  const target = await moderatePost(context.db, {
    ...args,
    operation: "remove",
    closeAppeals,
    emailLocale: localeFromRequest(context.headers),
  });
  return { pending: [{ sourceId: target.actionId, userId: target.authorId }] };
}

export async function suspendUserEffect(
  context: AppealContext,
  args: {
    userId: string;
    actorId: string;
    actorRole: string;
    reason: string;
    durationSeconds: number;
  },
  closeAppeals = false,
): Promise<{ banExpires: Date; pending: PendingEmail[] }> {
  const result = await moderateUser(context.db, {
    ...args,
    operation: "suspend",
    closeAppeals,
    emailLocale: localeFromRequest(context.headers),
  });
  if (!result.banExpires)
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to set the suspension expiry.",
    });
  return {
    banExpires: result.banExpires,
    pending: [{ sourceId: result.actionId, userId: args.userId }],
  };
}

export async function banUserEffect(
  context: AppealContext,
  args: { userId: string; actorId: string; actorRole: string; reason: string },
  closeAppeals = false,
): Promise<{ pending: PendingEmail[] }> {
  const result = await moderateUser(context.db, {
    ...args,
    operation: "ban",
    closeAppeals,
    emailLocale: localeFromRequest(context.headers),
  });
  return { pending: [{ sourceId: result.actionId, userId: args.userId }] };
}

export async function setRoleEffect(
  db: Database,
  args: {
    userId: string;
    actorId: string;
    actorRole: string;
    role: UserRole;
    emailLocale?: EmailLocale;
  },
  closeAppeals = false,
): Promise<{ pending: PendingEmail[] }> {
  const result = await moderateUser(db, { ...args, operation: "role", closeAppeals });
  return { pending: [{ sourceId: result.actionId, userId: args.userId }] };
}

/** A superseded grant is a no-op and owes no second notice. */
export async function restoreRoleEffect(
  db: Database,
  args: {
    userId: string;
    actorId: string;
    actorRole: string;
    grantedRole: string;
    oldRole: string;
    emailLocale?: EmailLocale;
  },
): Promise<{ pending: PendingEmail[] }> {
  const result = await moderateUser(db, { ...args, operation: "restoreRole" });
  return { pending: result.changed ? [{ sourceId: result.actionId, userId: args.userId }] : [] };
}

export async function restorePostEffect(
  db: Database,
  args: { postId: string; actorId: string; note?: string; emailLocale?: EmailLocale },
  closeAppeals = false,
): Promise<{ pending: PendingEmail[] }> {
  const target = await moderatePost(db, { ...args, operation: "restore", closeAppeals });
  return {
    pending: target.changed ? [{ sourceId: target.actionId, userId: target.authorId }] : [],
  };
}

export async function unbanEffect(
  db: Database,
  args: {
    userId: string;
    actorId: string;
    actorRole: string;
    note?: string;
    tolerateNotBanned?: boolean;
    emailLocale?: EmailLocale;
  },
  closeAppeals = false,
): Promise<{ pending: PendingEmail[] }> {
  const result = await moderateUser(db, { ...args, operation: "unban", closeAppeals });
  return { pending: result.changed ? [{ sourceId: result.actionId, userId: args.userId }] : [] };
}

/**
 * The guard of every path that would touch an author-deleted post: withdraw
 * its open appeals first, then refuse with {@link POST_AUTHOR_DELETED_MESSAGE}.
 *
 * The effects' own batch guards remain the authority. This pre-read decides whether to run the
 * withdrawal before refusing. A deletion landing between this read and the
 * effect's guard leaves the stamp to the next attempt; stamping is idempotent
 * (`status = 'open'`), and the refusal is identical either way.
 */
export async function refuseIfAuthorDeleted(db: Database, postId: string): Promise<void> {
  const [row] = await db
    .select({ deletedAt: post.deletedAt })
    .from(post)
    .where(eq(post.id, postId))
    .limit(1);
  if (!row?.deletedAt) return;

  await withdrawDeletedPostAppeals(db, postId);
  throw new ORPCError("BAD_REQUEST", { message: POST_AUTHOR_DELETED_MESSAGE });
}

/**
 * Removes a post and emails the author — the notice goes out after the removal
 * commits, and any open appeal against an earlier removal of the same post is
 * closed as superseded in the same transaction.
 */
export async function removePost(
  context: EffectContext & AppealContext,
  args: { postId: string; actorId: string; reason: string },
): Promise<void> {
  // Outside the effect transaction on purpose: when it fires, the withdrawal
  // has already committed, and the refusal must not roll it back.
  await refuseIfAuthorDeleted(context.db, args.postId);
  const { pending } = await removePostEffect(context, args, true);
  for (const email of pending) await deliverModerationEmails(context, email.sourceId);
}

/** Restores a removed post and emails the author when something was actually restored. */
export async function restorePost(
  context: EffectContext,
  args: { postId: string; actorId: string; note?: string },
): Promise<void> {
  // Same placement as `removePost`'s guard: the author-deleted withdrawal
  // must commit before the refusal, not roll back with it.
  await refuseIfAuthorDeleted(context.db, args.postId);
  const { pending } = await restorePostEffect(
    context.db,
    { ...args, emailLocale: localeFromRequest(context.headers) },
    true,
  );
  for (const email of pending) await deliverModerationEmails(context, email.sourceId);
}

/** Suspends and sends after commit, returning the stored expiry. */
export async function suspendUser(
  context: EffectContext & AppealContext,
  args: {
    userId: string;
    actorId: string;
    actorRole: string;
    reason: string;
    durationSeconds: number;
  },
): Promise<Date> {
  const { banExpires, pending } = await suspendUserEffect(context, args, true);
  for (const email of pending) await deliverModerationEmails(context, email.sourceId);
  return banExpires;
}

/** Bans and supersedes older sanction appeals, then sends the notice. */
export async function banUser(
  context: EffectContext & AppealContext,
  args: { userId: string; actorId: string; actorRole: string; reason: string },
): Promise<void> {
  const { pending } = await banUserEffect(context, args, true);
  for (const email of pending) await deliverModerationEmails(context, email.sourceId);
}

/** Unbans or unsuspends, closes sanction appeals, then sends the precise notice. */
export async function unbanUser(
  context: EffectContext,
  args: { userId: string; actorId: string; actorRole: string; note?: string },
): Promise<void> {
  const { pending } = await unbanEffect(
    context.db,
    { ...args, emailLocale: localeFromRequest(context.headers) },
    true,
  );
  for (const email of pending) await deliverModerationEmails(context, email.sourceId);
}

/** Changes role and closes only role appeals, then sends the notice. */
export async function setRole(
  context: EffectContext,
  args: { userId: string; actorId: string; actorRole: string; role: UserRole },
): Promise<void> {
  const { pending } = await setRoleEffect(
    context.db,
    { ...args, emailLocale: localeFromRequest(context.headers) },
    true,
  );
  for (const email of pending) await deliverModerationEmails(context, email.sourceId);
}
