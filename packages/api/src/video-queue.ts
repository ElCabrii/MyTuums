import { sql, SQL } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import type { Database } from "@my-tuums/db";
import { z } from "zod";
import { runSql } from "./sql.js";

export const VIDEO_QUEUE_SCHEMA = "video_jobs";
export const VIDEO_PROCESS_QUEUE = "video-process";
export const VIDEO_MAINTENANCE_QUEUE = "video-maintenance";
export const VIDEO_MAX_ATTEMPTS = 3;
export const VIDEO_LEASE_SECONDS = 90;
export const VIDEO_PROCESS_TIMEOUT_SECONDS = 1800;
const queueRow = z.record(z.string(), z.unknown());
const queueResults = z.array(z.union([queueRow, z.array(queueRow)]));

function queueDatabase(db: Pick<Database, "execute">) {
  // pg-boss 12.26's adapter expects node-postgres result objects. Our driver
  // returns rows directly; normalize that shape while retaining its binding
  // parser and the caller's transaction/pool.
  const adapter = fromDrizzle(
    {
      async execute(query) {
        if (!(query instanceof SQL)) throw new Error("Expected a parameterized queue query.");
        const result = queueResults.parse(await runSql(db, query));
        // postgres-js returns one RowList per statement for a multi-statement query.
        return { rows: result.flatMap((row) => (Array.isArray(row) ? row : [row])) };
      },
    },
    sql,
  );
  return {
    executeSql(text: string, values?: unknown[]) {
      // node-postgres binds undefined as SQL NULL; postgres-js requires that
      // normalization explicitly, including schedules without a payload.
      return adapter.executeSql(
        text,
        values?.map((value) => {
          if (value === undefined) return null;
          // Drizzle's untyped sql.param has no JSON column encoder. Match pg's
          // JSON-object binding while preserving SQL arrays, dates and byte buffers.
          if (queueRow.safeParse(value).success) return JSON.stringify(value);
          return value;
        }),
      );
    },
  };
}

/**
 * Reuses the application's pool and its TLS policy. Schema creation belongs
 * to committed pre-deploy migrations; starting a worker never runs DDL.
 */
export function createVideoQueue(db: Database, worker: boolean): PgBoss {
  const adapter = queueDatabase(db);
  return new PgBoss({
    db: {
      async executeSql(text, values) {
        const statement = text.trim();
        // Queue maintenance emits explicit transactions. postgres-js correctly
        // rejects BEGIN on a pooled, unreserved connection: let Drizzle reserve
        // the connection and own COMMIT/ROLLBACK, preserving the vendor locks.
        if (statement.startsWith("BEGIN;") && statement.endsWith("COMMIT;")) {
          const body = statement.slice("BEGIN;".length, -"COMMIT;".length);
          return db.transaction((tx) => queueDatabase(tx).executeSql(body, values));
        }
        return adapter.executeSql(text, values);
      },
    },
    schema: VIDEO_QUEUE_SCHEMA,
    migrate: false,
    createSchema: false,
    // Queue counts are read live for metrics. Persisting historical snapshots
    // would make the library create time partitions during worker maintenance.
    persistQueueStats: false,
    supervise: worker,
    schedule: worker,
  });
}

export async function configureVideoQueues(queue: PgBoss): Promise<void> {
  await queue.createQueue(VIDEO_PROCESS_QUEUE, {
    policy: "exclusive",
    partition: false,
    retryLimit: VIDEO_MAX_ATTEMPTS - 1,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: VIDEO_PROCESS_TIMEOUT_SECONDS,
    heartbeatSeconds: VIDEO_LEASE_SECONDS,
    retentionSeconds: 24 * 60 * 60,
    deleteAfterSeconds: 60 * 60,
  });
  await queue.createQueue(VIDEO_MAINTENANCE_QUEUE, {
    policy: "singleton",
    partition: false,
    retryLimit: 2,
    retryDelay: 30,
    expireInSeconds: 300,
    retentionSeconds: 60 * 60,
    deleteAfterSeconds: 60 * 60,
  });
}

/** Submission and enqueue use the same transaction, including rollback. */
export async function enqueueVideo(
  queue: Pick<PgBoss, "send">,
  tx: Pick<Database, "execute">,
  videoId: string,
): Promise<void> {
  // An existing job with the same key already owns the scheduling obligation.
  await queue.send(
    VIDEO_PROCESS_QUEUE,
    { videoId },
    { singletonKey: videoId, db: queueDatabase(tx) },
  );
}
