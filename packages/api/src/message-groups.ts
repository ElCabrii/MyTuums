import { ORPCError } from "@orpc/server";
import { and, eq, not, sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { conversation, conversationParticipant, user, userBlock } from "@my-tuums/db/schema";
import type { Database } from "@my-tuums/db";
import type { Context } from "./context.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { effectivelyBanned } from "./visibility.js";
import { publishMessageEvent, type MessagePushEvent } from "./message-events.js";
import { jsonDecoder } from "./sql.js";
import { GROUP_MEMBER_LIMIT, GROUP_NAME_MAX_LENGTH } from "./constants.js";

const now = sql`cast(unixepoch('subsec') * 1000 as integer)`;
const day = 86_400_000;
const groupInput = z.object({ conversationId: z.uuid() });
const groupName = z.string().trim().min(1).max(GROUP_NAME_MAX_LENGTH);

/** Membership is independent of hiding a conversation from one's inbox. */
export function joinedGroup(conversationId: string | SQLWrapper, viewerId: string) {
  return sql`exists (select 1 from conversation_participant gp
    inner join conversation gc on gc.id = gp.conversation_id
    where gc.id = ${conversationId} and gc.kind = 'group'
      and gp.user_id = ${viewerId} and gp.membership = 'joined')`;
}

function eligibleMember(conversationId: string, viewerId: string) {
  return sql`${joinedGroup(conversationId, viewerId)} and ${eligibleAccount(viewerId)}`;
}

function eligibleAccount(viewerId: string) {
  return sql`exists (select 1 from ${user} where ${user.id} = ${viewerId} and ${not(effectivelyBanned)})`;
}

/** Counts recipients, not requests, across all groups and all recipient states. */
function invitationBudget(viewerId: string, count: number) {
  return sql`(select count(*) from conversation_participant
      where invited_by = ${viewerId} and invited_at > ${now} - 3600000) + ${count} <= 10
    and (select count(*) from conversation_participant
      where invited_by = ${viewerId} and invited_at > ${now} - ${day}) + ${count} <= 30`;
}

export async function notifyConversation(
  context: Pick<Context, "db" | "messageNotifier">,
  conversationId: string,
  kind: "message" | "conversation",
) {
  try {
    const participants = await context.db
      .select({ userId: conversationParticipant.userId })
      .from(conversationParticipant)
      .where(
        and(
          eq(conversationParticipant.conversationId, conversationId),
          eq(conversationParticipant.membership, "joined"),
        ),
      );
    await Promise.all(
      participants.map(({ userId }) =>
        publishMessageEvent(context.messageNotifier, userId, { kind, conversationId }),
      ),
    );
  } catch {
    // The mutation already committed. A failed audience read or push must not
    // turn it into a failed send; reconnect/focus recovers from D1.
  }
}

const memberSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string().nullable(),
  displayUsername: z.string().nullable(),
  image: z.string().nullable(),
});

export function groupMembersSelection() {
  return sql`(select json_group_array(json_object('id', u.id, 'name', u.name,
    'username', u.username, 'displayUsername', u.display_username, 'image', u.image))
    from conversation_participant gp inner join user u on u.id = gp.user_id
    where gp.conversation_id = ${conversation.id} and gp.membership = 'joined')`.mapWith(
    jsonDecoder(z.array(memberSchema)),
  );
}

function blockedMember(conversationId: string, viewerId: string) {
  return sql`exists (select 1 from conversation_participant gp
    inner join ${userBlock} on
      ((${userBlock.blockerId} = ${viewerId} and ${userBlock.blockedId} = gp.user_id)
      or (${userBlock.blockedId} = ${viewerId} and ${userBlock.blockerId} = gp.user_id))
    where gp.conversation_id = ${conversationId} and gp.membership = 'joined')`;
}

async function requireGroup(db: Database, conversationId: string, viewerId: string) {
  const [row] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eligibleMember(conversationId, viewerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
}

export const messageGroupRouter = {
  createGroup: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(
      z.object({
        name: groupName,
        recipientIds: z
          .array(z.string().min(1))
          .min(1)
          .max(GROUP_MEMBER_LIMIT - 1),
      }),
    )
    .handler(async ({ input, context }) => {
      const me = context.user.id;
      const ids = [...new Set(input.recipientIds)];
      if (ids.includes(me)) throw new ORPCError("BAD_REQUEST");
      const id = crypto.randomUUID();
      const recipients = JSON.stringify(ids);
      const eligible = sql`${eligibleAccount(me)} and ${invitationBudget(me, ids.length)}
        and (select count(*) from ${user} where ${user.id} in (select value from json_each(${recipients}))) = ${ids.length}`;
      const [created] = await context.db.batch([
        context.db
          .insert(conversation)
          .select(
            sql`select ${id}, null, null, 'group', ${input.name}, ${now}, ${now} where ${eligible}`,
          )
          .returning({ id: conversation.id }),
        context.db.insert(conversationParticipant).select(sql`select c.id, u.id,
          case when u.id = ${me} then 'active' else 'pending' end,
          case when u.id = ${me} then 'joined' else 'invited' end,
          case when u.id = ${me} then null else ${me} end,
          case when u.id = ${me} then null else ${now} end, null, null, ${now}
          from conversation c, user u where c.id = ${id}
          and (u.id = ${me} or u.id in (select value from json_each(${recipients})))`),
      ]);
      if (!created[0])
        throw new ORPCError("BAD_REQUEST", {
          message: "Cannot create this group. Check the recipients or try again later.",
        });
      await Promise.all(
        [me, ...ids].map((userId) =>
          publishMessageEvent(context.messageNotifier, userId, {
            kind: "conversation",
            conversationId: id,
          }),
        ),
      );
      return { conversationId: id };
    }),

  invite: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(groupInput.extend({ userId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const me = context.user.id;
      await requireGroup(context.db, input.conversationId, me);
      const target = and(
        eq(conversationParticipant.conversationId, input.conversationId),
        eq(conversationParticipant.userId, input.userId),
      );
      const [existing] = await context.db
        .select({ membership: conversationParticipant.membership })
        .from(conversationParticipant)
        .where(target);
      if (existing?.membership === "invited" || existing?.membership === "joined")
        return { conversationId: input.conversationId };
      const eligible = sql`${eligibleMember(input.conversationId, me)} and ${invitationBudget(me, 1)}
        and exists (select 1 from user where id = ${input.userId})
        and (select count(*) from conversation_participant where conversation_id = ${input.conversationId} and membership = 'joined') < ${GROUP_MEMBER_LIMIT}
        and not exists (select 1 from conversation_participant where conversation_id = ${input.conversationId}
          and user_id = ${input.userId} and (membership in ('joined', 'invited') or departed_at > ${now} - ${day}))`;
      const rows = await context.db
        .insert(conversationParticipant)
        .select(
          sql`select ${input.conversationId}, ${input.userId}, 'pending', 'invited', ${me}, ${now}, null, null, ${now} where ${eligible}`,
        )
        .onConflictDoUpdate({
          target: [conversationParticipant.conversationId, conversationParticipant.userId],
          set: {
            status: "pending",
            membership: "invited",
            invitedBy: me,
            invitedAt: now,
            departedAt: null,
          },
        })
        .returning({ userId: conversationParticipant.userId });
      if (!rows[0])
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message:
            "This invitation is unavailable. The group may be full; otherwise try again later.",
        });
      await publishMessageEvent(context.messageNotifier, input.userId, {
        kind: "conversation",
        conversationId: input.conversationId,
      });
      return { conversationId: input.conversationId };
    }),

  join: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(groupInput.extend({ confirmBlocked: z.boolean().default(false) }))
    .handler(async ({ input, context }) => {
      const me = context.user.id;
      const invitation = and(
        eq(conversationParticipant.conversationId, input.conversationId),
        eq(conversationParticipant.userId, me),
        eq(conversationParticipant.membership, "invited"),
      );
      const blocked = blockedMember(input.conversationId, me);
      const [joined, pending] = await context.db.batch([
        context.db
          .update(conversationParticipant)
          .set({
            membership: "joined",
            status: "active",
            departedAt: null,
            lastReadAt: sql`(select last_message_at from conversation where id = ${input.conversationId})`,
          })
          .where(
            and(
              invitation,
              eligibleAccount(me),
              sql`exists (select 1 from conversation where id = ${input.conversationId} and kind = 'group')`,
              sql`(select count(*) from conversation_participant where conversation_id = ${input.conversationId} and membership = 'joined') between 1 and ${GROUP_MEMBER_LIMIT - 1}`,
              sql`(${input.confirmBlocked} or not ${blocked})`,
            ),
          )
          .returning({ id: conversationParticipant.userId }),
        context.db
          .select({ blocked: blocked.mapWith(Boolean) })
          .from(conversationParticipant)
          .where(invitation),
      ]);
      if (joined[0]) {
        await notifyConversation(context, input.conversationId, "conversation");
        return { conversationId: input.conversationId, requiresConfirmation: false };
      }
      if (pending[0]?.blocked && !input.confirmBlocked)
        return { conversationId: input.conversationId, requiresConfirmation: true };
      throw new ORPCError("CONFLICT", {
        message: "This invitation is no longer available or the group is full.",
      });
    }),

  renameGroup: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(groupInput.extend({ name: groupName }))
    .handler(async ({ input, context }) => {
      const rows = await context.db
        .update(conversation)
        .set({ name: input.name })
        .where(
          and(
            eq(conversation.id, input.conversationId),
            eligibleMember(input.conversationId, context.user.id),
          ),
        )
        .returning({ id: conversation.id });
      if (!rows[0]) throw new ORPCError("NOT_FOUND");
      await notifyConversation(context, input.conversationId, "conversation");
      return { conversationId: input.conversationId };
    }),

  leaveGroup: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(groupInput)
    .handler(async ({ input, context }) =>
      depart(context, input.conversationId, context.user.id, context.user.id),
    ),
  removeMember: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(groupInput.extend({ userId: z.string().min(1) }))
    .handler(async ({ input, context }) =>
      depart(context, input.conversationId, context.user.id, input.userId),
    ),
};

async function depart(context: Context, conversationId: string, actorId: string, targetId: string) {
  const rows = await context.db
    .update(conversationParticipant)
    .set({
      membership: actorId === targetId ? "left" : "removed",
      status: "hidden",
      departedAt: now,
    })
    .where(
      and(
        eq(conversationParticipant.conversationId, conversationId),
        eq(conversationParticipant.userId, targetId),
        eq(conversationParticipant.membership, "joined"),
        eligibleMember(conversationId, actorId),
      ),
    )
    .returning({ userId: conversationParticipant.userId });
  if (!rows[0]) throw new ORPCError("NOT_FOUND");
  const event: MessagePushEvent = { kind: "revoked", conversationId };
  await publishMessageEvent(context.messageNotifier, targetId, event);
  await notifyConversation(context, conversationId, "conversation");
  return { conversationId };
}
