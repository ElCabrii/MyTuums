import type { Workflow, WorkflowInstance } from "@cloudflare/workers-types";
import type { Database } from "@my-tuums/db";
import { jobIntent } from "@my-tuums/db/schema";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { textIn } from "./sql.js";

type JobKind = typeof jobIntent.$inferSelect.kind;
type JobParams = { entityId: string };
/** Only the native Workflow capabilities the dispatcher uses. */
export interface JobWorkflow {
  create(...args: Parameters<Workflow<JobParams>["create"]>): Promise<Pick<WorkflowInstance, "id">>;
  get(id: string): Promise<Pick<WorkflowInstance, "status">>;
}

/** Include this statement in the same D1 batch as the work's source transition. */
export function jobIntentInsert(
  db: Database,
  args: { id: string; kind: JobKind; entityId: string },
  when: SQL = sql`true`,
) {
  return db
    .insert(jobIntent)
    .select(
      sql`select ${args.id}, ${args.kind}, ${args.entityId}, 0,
    cast(unixepoch('subsec') * 1000 as integer), null, cast(unixepoch('subsec') * 1000 as integer)
    where ${when}`,
    )
    .onConflictDoNothing();
}

/** Each Worker recovers only the kinds for which it owns a Workflow binding. */
export function createJobDispatcher(
  db: Database,
  workflows: Partial<Record<JobKind, JobWorkflow>>,
) {
  async function dispatch(id: string): Promise<boolean> {
    const [job] = await db
      .select()
      .from(jobIntent)
      .where(and(eq(jobIntent.id, id), isNull(jobIntent.dispatchedAt)));
    if (!job) return true;
    const workflow = workflows[job.kind];
    if (!workflow) return false;
    try {
      try {
        await workflow.create({ id: job.id, params: { entityId: job.entityId } });
      } catch {
        // A duplicate ID or lost creation acknowledgement can already have a
        // durable instance. A handle alone is not proof: read its status.
        const instance = await workflow.get(job.id);
        const status = await instance.status();
        if (status.status === "unknown") throw new Error("Workflow creation is unconfirmed.");
      }
      await db
        .update(jobIntent)
        .set({ dispatchedAt: sql`cast(unixepoch('subsec') * 1000 as integer)` })
        .where(and(eq(jobIntent.id, job.id), isNull(jobIntent.dispatchedAt)));
      return true;
    } catch {
      await db
        .update(jobIntent)
        .set({
          attempts: sql`${jobIntent.attempts} + 1`,
          nextAttemptAt: sql`cast(unixepoch('subsec') * 1000 as integer) + min(3600000, 30000 * (1 << min(${jobIntent.attempts}, 7)))`,
        })
        .where(and(eq(jobIntent.id, job.id), isNull(jobIntent.dispatchedAt)));
      console.error({ event: "job_dispatch_deferred", jobId: job.id, kind: job.kind });
      return false;
    }
  }
  return {
    dispatch,
    async recover() {
      const due = await db
        .select({ id: jobIntent.id })
        .from(jobIntent)
        .where(
          and(
            isNull(jobIntent.dispatchedAt),
            textIn(jobIntent.kind, Object.keys(workflows)),
            sql`${jobIntent.nextAttemptAt} <= cast(unixepoch('subsec') * 1000 as integer)`,
          ),
        )
        .orderBy(jobIntent.nextAttemptAt, jobIntent.id)
        .limit(50);
      let dispatched = 0;
      for (const job of due) if (await dispatch(job.id)) dispatched += 1;
      return { scanned: due.length, dispatched };
    },
  };
}

export type JobDispatcher = Pick<ReturnType<typeof createJobDispatcher>, "dispatch">;

export interface MonitoredWorkflow {
  get(id: string): Promise<Pick<WorkflowInstance, "status" | "restart">>;
}

/**
 * Instance creation is not completion. Retry an errored instance under its
 * original ID, leaving application idempotency/deadline guards in charge.
 * Only confirmed completion retires the intent. Unconfirmed status returns to
 * dispatch under the same ID, covering expired provider instance retention.
 */
export async function monitorDispatchedJobs(
  db: Database,
  workflows: Partial<Record<JobKind, MonitoredWorkflow>>,
) {
  const due = await db
    .select()
    .from(jobIntent)
    .where(
      and(
        isNotNull(jobIntent.dispatchedAt),
        textIn(jobIntent.kind, Object.keys(workflows)),
        sql`${jobIntent.nextAttemptAt} <= cast(unixepoch('subsec') * 1000 as integer)`,
      ),
    )
    .orderBy(jobIntent.nextAttemptAt, jobIntent.id)
    .limit(50);
  let completed = 0;
  let restarted = 0;
  for (const job of due) {
    const workflow = workflows[job.kind];
    if (!workflow) continue;
    try {
      const instance = await workflow.get(job.id);
      const status = await instance.status();
      if (status.status === "complete") {
        const removed = await db
          .delete(jobIntent)
          .where(and(eq(jobIntent.id, job.id), isNotNull(jobIntent.dispatchedAt)))
          .returning({ id: jobIntent.id });
        completed += removed.length;
      } else if (status.status === "errored") {
        await instance.restart();
        restarted += 1;
        await db
          .update(jobIntent)
          .set({
            attempts: sql`${jobIntent.attempts} + 1`,
            nextAttemptAt: sql`cast(unixepoch('subsec') * 1000 as integer) + min(3600000, 60000 * (1 << min(${jobIntent.attempts}, 6)))`,
          })
          .where(eq(jobIntent.id, job.id));
        console.error({ event: "job_restarted", jobId: job.id, kind: job.kind });
      } else {
        if (status.status === "unknown") throw new Error("Workflow status is unconfirmed.");
        // Paused and terminated instances reflect explicit operator actions.
        await db
          .update(jobIntent)
          .set({ nextAttemptAt: sql`cast(unixepoch('subsec') * 1000 as integer) + 60000` })
          .where(eq(jobIntent.id, job.id));
      }
    } catch {
      await db
        .update(jobIntent)
        .set({
          dispatchedAt: null,
          nextAttemptAt: sql`cast(unixepoch('subsec') * 1000 as integer) + 60000`,
        })
        .where(eq(jobIntent.id, job.id));
      console.error({ event: "job_monitor_deferred", jobId: job.id, kind: job.kind });
    }
  }
  return { scanned: due.length, completed, restarted };
}
