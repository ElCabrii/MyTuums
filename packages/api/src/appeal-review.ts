import { ORPCError } from "@orpc/server";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import { localeFromRequest, type EmailLocale } from "@my-tuums/auth";
import type { Database } from "@my-tuums/db";
import { appeal, moderationAction, user } from "@my-tuums/db/schema";
import { APPEALABLE_ACTIONS } from "./constants.js";
import type { Context } from "./context.js";
import { moderationActionState } from "./moderation-action-state.js";
import { refuseIfAuthorDeleted } from "./moderation-actions.js";
import { deliverModerationEmails, moderationEmailInsert } from "./moderation-email.js";
import { postModerationStatements } from "./moderation-post.js";
import { userModerationStatements } from "./moderation-user.js";
import { notificationInsert } from "./notification-writer.js";
import { canManageRole } from "./roles.js";

type ReviewRequest = {
  appealId: string;
  outcome: "upheld" | "overturned";
  note?: string;
  actorId: string;
  actorRole: string;
};

function reviewSnapshot(db: Database, appealId: string) {
  return db
    .select({
      status: appeal.status,
      appellantId: appeal.appellantId,
      action: {
        id: moderationAction.id,
        action: moderationAction.action,
        actorId: moderationAction.actorId,
        targetType: moderationAction.targetType,
        targetPostId: moderationAction.targetPostId,
        targetUserId: moderationAction.targetUserId,
        details: moderationAction.details,
      },
      current: moderationActionState.current,
      latest: moderationActionState.latest,
      role: user.role,
    })
    .from(appeal)
    .innerJoin(moderationAction, eq(moderationAction.id, appeal.actionId))
    .leftJoin(user, eq(user.id, moderationAction.targetUserId))
    .where(eq(appeal.id, appealId));
}

type ReviewRow = Awaited<ReturnType<typeof reviewSnapshot>>[number];

function assertOpenReview(row: ReviewRow | undefined, actorId: string): asserts row is ReviewRow {
  if (!row) throw new ORPCError("NOT_FOUND", { message: "This appeal doesn't exist." });
  if (row.status !== "open")
    throw new ORPCError("BAD_REQUEST", { message: "This appeal has already been resolved." });
  if (row.action.actorId === actorId)
    throw new ORPCError("FORBIDDEN", { message: "You can't review your own action." });
}

const roleChange = z.object({ oldRole: z.string().min(1), newRole: z.string().min(1) });

/** Return statements only: the inverse must never commit outside the review. */
function reviewInverse(
  db: Database,
  row: ReviewRow,
  input: ReviewRequest,
  when: SQL,
  emailLocale: EmailLocale,
) {
  const action = row.action;
  const common = { actorId: input.actorId, note: input.note, emailLocale };
  switch (action.action) {
    case "post_removed": {
      if (!action.targetPostId) return;
      const plan = postModerationStatements(
        db,
        {
          ...common,
          operation: "restore",
          postId: action.targetPostId,
        },
        when,
      );
      return plan;
    }
    case "user_suspended":
    case "user_banned": {
      if (!action.targetUserId) return;
      const plan = userModerationStatements(
        db,
        {
          ...common,
          operation: "unban",
          userId: action.targetUserId,
          actorRole: input.actorRole,
        },
        when,
      );
      return plan;
    }
    case "role_changed": {
      const details = roleChange.safeParse(action.details);
      if (!details.success || !action.targetUserId) return;
      const plan = userModerationStatements(
        db,
        {
          ...common,
          operation: "restoreRole",
          userId: action.targetUserId,
          actorRole: input.actorRole,
          grantedRole: details.data.newRole,
          oldRole: details.data.oldRole,
        },
        when,
      );
      return plan;
    }
  }
}

/**
 * A guarded inverse (if requested), review stamp, audit and notices share one
 * serialized D1 batch. The immutable action is read first only to choose the
 * inverse statements. The batch rechecks appeal status, author, action order,
 * current state and target rank before any write. Its snapshot explains a lost
 * race; its newly minted audit row proves which reviewer actually changed state.
 */
export async function reviewAppeal(
  context: Pick<
    Context,
    "db" | "headers" | "emailSender" | "webOrigin" | "requestId" | "appealToken"
  >,
  input: ReviewRequest,
) {
  const db = context.db;
  const [initial] = await reviewSnapshot(db, input.appealId);
  assertOpenReview(initial, input.actorId);
  if (input.outcome === "overturned" && initial.action.targetPostId)
    await refuseIfAuthorDeleted(db, initial.action.targetPostId);

  const eligible = sql`exists (select 1 from ${appeal}
    inner join ${moderationAction} on ${moderationAction.id} = ${appeal.actionId}
    where ${appeal.id} = ${input.appealId} and ${appeal.status} = 'open'
      and ${moderationAction.id} = ${initial.action.id}
      and ${moderationAction.actorId} is not ${input.actorId}
      and (${moderationActionState.latest})
      and (${input.outcome === "overturned" ? moderationActionState.current : sql`1`}))`;
  const inverse =
    input.outcome === "overturned"
      ? reviewInverse(db, initial, input, eligible, localeFromRequest(context.headers))
      : undefined;
  const resolutionId = crypto.randomUUID();
  const changed =
    input.outcome === "upheld"
      ? eligible
      : inverse
        ? sql`exists (select 1 from ${moderationAction} where ${moderationAction.id} = ${inverse.actionId})`
        : sql`0`;
  const applied = sql`exists (select 1 from ${moderationAction} where ${moderationAction.id} = ${resolutionId})`;
  const statements: BatchItem<"sqlite">[] = [...(inverse?.statements ?? [])];
  // Every moderation_action column, in schema order. After an inverse the
  // original action is no longer current; its committed marker gates this row.
  statements.push(
    db.insert(moderationAction).select(sql`select ${resolutionId},
    'appeal_resolved', ${input.actorId}, ${initial.action.targetType},
    ${initial.action.targetPostId}, ${initial.action.targetUserId}, null, ${input.note ?? null},
    ${JSON.stringify({ outcome: input.outcome })}, cast(unixepoch('subsec') * 1000 as integer)
    where ${changed}`),
  );
  statements.push(
    db
      .update(appeal)
      .set({
        status: input.outcome,
        reviewedBy: input.actorId,
        reviewNote: input.note ?? null,
        reviewedAt: sql`(select ${moderationAction.createdAt} from ${moderationAction}
      where ${moderationAction.id} = ${resolutionId})`,
      })
      .where(and(eq(appeal.id, input.appealId), applied)),
  );
  const notice = notificationInsert(
    db,
    {
      recipientId: initial.appellantId,
      actorId: null,
      type: "moderation",
      actionId: resolutionId,
    },
    applied,
  );
  if (notice) statements.push(notice);
  statements.push(
    moderationEmailInsert(
      db,
      {
        sourceId: resolutionId,
        recipients: sql`select ${initial.appellantId}`,
        fallbackLocale: localeFromRequest(context.headers),
        content: sql`json_object('kind', 'appeal_resolved', 'outcome', ${input.outcome}, 'note', ${input.note ?? null})`,
      },
      applied,
    ),
  );
  const [snapshots, ...results] = await db.batch([
    reviewSnapshot(db, input.appealId),
    ...statements,
    db
      .select({ id: moderationAction.id })
      .from(moderationAction)
      .where(eq(moderationAction.id, resolutionId)),
  ]);
  const committed = z.array(z.object({ id: z.string() })).parse(results.at(-1));
  if (committed.length === 0) {
    const snapshot = snapshots[0];
    assertOpenReview(snapshot, input.actorId);
    if (!snapshot.latest)
      throw new ORPCError("BAD_REQUEST", {
        message: "A newer moderation action has superseded this one.",
      });
    if (!APPEALABLE_ACTIONS.some((action) => action === snapshot.action.action))
      throw new ORPCError("BAD_REQUEST", { message: "This action can't be overturned." });
    if (!snapshot.current)
      throw new ORPCError("BAD_REQUEST", {
        message: "There's nothing left to overturn — this action was already undone.",
      });
    if (snapshot.action.targetPostId) await refuseIfAuthorDeleted(db, snapshot.action.targetPostId);
    if (!inverse)
      throw new ORPCError("BAD_REQUEST", { message: "This action can't be overturned." });
    const details = roleChange.safeParse(snapshot.action.details);
    if (
      snapshot.action.targetType === "user" &&
      (!canManageRole(input.actorRole, snapshot.role ?? "user") ||
        (snapshot.action.action === "role_changed" &&
          details.success &&
          !canManageRole(input.actorRole, details.data.oldRole)))
    )
      throw new ORPCError("FORBIDDEN");
    // A suspension can expire between statements even within a serialized
    // batch. Nothing was committed, so report the same already-undone refusal.
    throw new ORPCError("BAD_REQUEST", {
      message: "There's nothing left to overturn — this action was already undone.",
    });
  }
  if (inverse) await deliverModerationEmails(context, inverse.actionId);
  await deliverModerationEmails(context, resolutionId);
  return { appealId: input.appealId, status: input.outcome };
}
