import { jobIntent, post, user, video, videoSubmission } from "@my-tuums/db/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import {
  createJobDispatcher,
  jobIntentInsert,
  monitorDispatchedJobs,
  type JobWorkflow,
  type MonitoredWorkflow,
} from "./jobs.js";
import { submitVideo } from "./video-lifecycle.js";
import { createTestUser, truncateAll } from "./testing/harness.js";
import { closeDb, db } from "./testing/runtime.js";

beforeEach(async () => {
  await truncateAll();
  await db.delete(video);
});
afterAll(closeDb);

function workflow() {
  const instances = new Set<string>();
  const binding: JobWorkflow = {
    create(options) {
      if (!options?.id) return Promise.reject(new Error("Missing ID"));
      instances.add(options.id);
      // The provider persisted the instance but its response did not reach us.
      return Promise.reject(new Error("Lost acknowledgement"));
    },
    get(id) {
      return Promise.resolve({
        status() {
          return instances.has(id)
            ? Promise.resolve({ status: "running" as const })
            : Promise.reject(new Error("Missing instance"));
        },
      });
    },
  };
  return { instances, binding };
}

async function upload() {
  const owner = await createTestUser();
  const videoId = crypto.randomUUID();
  await db.insert(video).values({
    id: videoId,
    authorId: owner.id,
    state: "uploaded",
    byteSize: 10,
    streamCreatorId: `mytuums-test:${videoId}`,
    streamUid: videoId.replaceAll("-", ""),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return {
    videoId,
    authorId: owner.id,
    content: "Private pending text",
    parentId: null,
    quotedPostId: null,
    isPrivate: true,
    caption: "Private caption",
    captionLanguage: "en",
  };
}

it("commits one private submission and recoverable dispatch across concurrent retries", async () => {
  const args = await upload();
  const failing = { dispatch: () => Promise.reject(new Error("Unavailable")) };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => submitVideo(db, failing, args)),
  );
  expect(new Set(results.map((result) => result.id)).size).toBe(1);
  expect(results.every((result) => result.status === "pending")).toBe(true);
  expect(await db.select().from(post)).toHaveLength(0);
  expect(await db.select().from(videoSubmission)).toMatchObject([
    { content: args.content, caption: args.caption },
  ]);
  const jobs = await db.select().from(jobIntent);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    id: `video-${args.videoId}`,
    entityId: args.videoId,
    kind: "video",
    dispatchedAt: null,
  });
  expect(JSON.stringify(jobs)).not.toContain(args.content);
  expect(JSON.stringify(jobs)).not.toContain(args.caption);
  const [saved] = await db.select().from(video);
  expect(saved?.state).toBe("queued");
  expect(saved.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(1_800_000);
  expect(saved.expiresAt.getTime() - Date.now()).toBeGreaterThan(1_790_000);
});

it("rolls back pending text and state when the dispatch obligation cannot be recorded", async () => {
  const args = await upload();
  const fake = workflow();
  const dispatcher = createJobDispatcher(db, {
    video: fake.binding,
    "game-sync": fake.binding,
    maintenance: fake.binding,
  });
  await db.run(sql`create trigger reject_job_intent_test before insert on job_intent
    begin select raise(abort, 'injected dispatch record failure'); end`);
  try {
    await expect(submitVideo(db, dispatcher, args)).rejects.toThrow();
  } finally {
    await db.run(sql`drop trigger reject_job_intent_test`);
  }
  expect(await db.select().from(videoSubmission)).toHaveLength(0);
  expect(await db.select().from(video)).toMatchObject([{ state: "uploaded" }]);
  expect(await db.select().from(jobIntent)).toHaveLength(0);
  expect(fake.instances.size).toBe(0);
});

it("recovers a committed obligation after account deletion and a lost Workflow acknowledgement", async () => {
  const args = await upload();
  await submitVideo(db, { dispatch: () => Promise.resolve(false) }, args);
  await db.delete(user).where(eq(user.id, args.authorId));
  expect(await db.select().from(videoSubmission)).toHaveLength(0);
  const fake = workflow();
  const dispatcher = createJobDispatcher(db, {
    video: fake.binding,
    "game-sync": fake.binding,
    maintenance: fake.binding,
  });
  expect(await dispatcher.recover()).toEqual({ scanned: 1, dispatched: 1 });
  expect(fake.instances).toEqual(new Set([`video-${args.videoId}`]));
  expect((await db.select().from(jobIntent))[0]?.dispatchedAt).toBeInstanceOf(Date);
  expect(await dispatcher.recover()).toEqual({ scanned: 0, dispatched: 0 });
});

it("does not acknowledge an unconfirmed instance and backs off its next recovery", async () => {
  await jobIntentInsert(db, {
    id: "video-unconfirmed",
    kind: "video",
    entityId: crypto.randomUUID(),
  });
  const unknown: JobWorkflow = {
    create: () => Promise.reject(new Error("No response")),
    get: () => Promise.resolve({ status: () => Promise.resolve({ status: "unknown" }) }),
  };
  const dispatcher = createJobDispatcher(db, {
    video: unknown,
    "game-sync": unknown,
    maintenance: unknown,
  });
  expect(await dispatcher.recover()).toEqual({ scanned: 1, dispatched: 0 });
  const [job] = await db.select().from(jobIntent);
  expect(job).toMatchObject({ attempts: 1, dispatchedAt: null });
  expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  expect(await dispatcher.recover()).toEqual({ scanned: 0, dispatched: 0 });
});

it("bounds recovery to fifty due jobs", async () => {
  const inserts = Array.from({ length: 55 }, (_, index) =>
    jobIntentInsert(db, {
      id: `maintenance-${index}`,
      kind: "maintenance",
      entityId: String(index),
    }),
  );
  await db.batch([inserts[0], ...inserts.slice(1)]);
  const fake = workflow();
  const dispatcher = createJobDispatcher(db, {
    video: fake.binding,
    "game-sync": fake.binding,
    maintenance: fake.binding,
  });
  expect(await dispatcher.recover()).toEqual({ scanned: 50, dispatched: 50 });
  expect(await dispatcher.recover()).toEqual({ scanned: 5, dispatched: 5 });
  expect(fake.instances.size).toBe(55);
});

it("leaves another Worker's jobs pending without letting them starve owned recovery", async () => {
  const other = Array.from({ length: 55 }, (_, index) =>
    jobIntentInsert(db, {
      id: `game-${index}`,
      kind: "game-sync",
      entityId: String(index),
    }),
  );
  await db.batch([other[0], ...other.slice(1)]);
  await jobIntentInsert(db, { id: "video-owned", kind: "video", entityId: crypto.randomUUID() });
  const fake = workflow();
  const dispatcher = createJobDispatcher(db, { video: fake.binding });
  expect(await dispatcher.dispatch("game-0")).toBe(false);
  expect(await dispatcher.recover()).toEqual({ scanned: 1, dispatched: 1 });
  expect(fake.instances).toEqual(new Set(["video-owned"]));
  expect(await db.select().from(jobIntent).where(eq(jobIntent.kind, "game-sync"))).toEqual(
    expect.arrayContaining([expect.objectContaining({ attempts: 0, dispatchedAt: null })]),
  );
  expect(await createJobDispatcher(db, {}).recover()).toEqual({ scanned: 0, dispatched: 0 });
});

it("retires confirmed completion, restarts errors, and preserves unknown or operator-stopped instances", async () => {
  const states = ["complete", "errored", "paused", "terminated", "unknown", "running"] as const;
  for (const status of states) {
    await db.insert(jobIntent).values({
      id: status,
      kind: "maintenance",
      entityId: status,
      dispatchedAt: new Date(),
      nextAttemptAt: new Date(0),
    });
  }
  const restarts: string[] = [];
  const binding: MonitoredWorkflow = {
    get(id) {
      const status = states.find((state) => state === id);
      if (!status) return Promise.reject(new Error("Missing test instance"));
      return Promise.resolve({
        status: () => Promise.resolve({ status }),
        restart: () => {
          restarts.push(id);
          return Promise.resolve();
        },
      });
    },
  };
  expect(await monitorDispatchedJobs(db, { maintenance: binding })).toEqual({
    scanned: 6,
    completed: 1,
    restarted: 1,
  });
  expect(restarts).toEqual(["errored"]);
  const remaining = await db.select().from(jobIntent);
  expect(remaining.map((job) => job.id).sort()).toEqual([
    "errored",
    "paused",
    "running",
    "terminated",
    "unknown",
  ]);
  expect(remaining.every((job) => job.nextAttemptAt > new Date())).toBe(true);
  expect(remaining.find((job) => job.id === "unknown")?.dispatchedAt).toBeNull();
  expect(await monitorDispatchedJobs(db, { maintenance: binding })).toEqual({
    scanned: 0,
    completed: 0,
    restarted: 0,
  });
});

it("keeps an intent when the restart acknowledgement is lost", async () => {
  await db.insert(jobIntent).values({
    id: "restart-lost",
    kind: "video",
    entityId: crypto.randomUUID(),
    dispatchedAt: new Date(),
    nextAttemptAt: new Date(0),
  });
  const binding: MonitoredWorkflow = {
    get: () =>
      Promise.resolve({
        status: () => Promise.resolve({ status: "errored" }),
        restart: () => Promise.reject(new Error("Lost restart acknowledgement")),
      }),
  };
  expect(await monitorDispatchedJobs(db, { video: binding })).toEqual({
    scanned: 1,
    completed: 0,
    restarted: 0,
  });
  expect(await db.select().from(jobIntent)).toHaveLength(1);
});

it("recovers missing provider history through creation with the original stable ID", async () => {
  await db.insert(jobIntent).values({
    id: "expired-history",
    kind: "maintenance",
    entityId: "opaque-id",
    dispatchedAt: new Date(0),
    nextAttemptAt: new Date(0),
  });
  await monitorDispatchedJobs(db, {
    maintenance: {
      get: () => Promise.reject(new Error("Provider no longer retains this instance")),
    },
  });
  const [pending] = await db.select().from(jobIntent);
  expect(pending.dispatchedAt).toBeNull();
  await db
    .update(jobIntent)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(jobIntent.id, pending.id));
  const fake = workflow();
  expect(await createJobDispatcher(db, { maintenance: fake.binding }).recover()).toEqual({
    scanned: 1,
    dispatched: 1,
  });
  expect(fake.instances).toEqual(new Set(["expired-history"]));
});
