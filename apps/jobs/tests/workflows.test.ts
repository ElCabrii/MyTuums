import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { R2Bucket, Workflow, WorkflowInstance } from "@cloudflare/workers-types";
import { Miniflare, Response as LocalResponse } from "miniflare";
import { createR2Storage } from "@my-tuums/api/r2-storage";
import { createAppealTokenSigner } from "@my-tuums/api/cloudflare-jobs";
import { migrate } from "drizzle-orm/d1/migrator";
import { drizzle } from "drizzle-orm/d1";
import { createDatabase } from "@my-tuums/db";
import {
  jobIntent,
  game,
  gameCatalogState,
  mediaIntent,
  moderationAction,
  moderationEmail,
  notification,
  post,
  user,
  video,
  videoSubmission,
} from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

// A provider protocol fixture behind an actual workerd service binding. The jobs
// bundle and Workflow engine are unchanged; no account or external network is used.
const streamFixture = `
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
class Captions extends RpcTarget {
  constructor(db, uid) { super(); this.db = db; this.uid = uid; }
  async upload(language, input) {
    const text = await new Response(input).text();
    await this.db.prepare("insert or replace into test_caption values (?, ?, ?)").bind(this.uid, language, text).run();
  }
}
class Video extends RpcTarget {
  constructor(db, uid) { super(); this.db = db; this.uid = uid; }
  async details() {
    const row = await this.db.prepare("select stream_creator_id as creator from video where stream_uid = ?").bind(this.uid).first();
    return { id: this.uid, creator: row.creator, requireSignedURLs: true,
      uploaded: "2026-09-10T00:00:00Z", readyToStream: true,
      status: { state: "ready" }, duration: 6, input: { width: 640, height: 360 } };
  }
  get captions() { return new Captions(this.db, this.uid); }
}
export default class StreamFixture extends WorkerEntrypoint {
  video(uid) { return new Video(this.env.DB, uid); }
  async send(message) {
    await this.env.DB.prepare("insert into test_email (recipient, subject, body) values (?, ?, ?)")
      .bind(message.to, message.subject, message.text).run();
    return { messageId: crypto.randomUUID() };
  }
}
`;
const databaseId = `mytuums_workflows_${crypto.randomUUID()}_test`;
const appealSecret = "synthetic-appeal-secret-at-least-32-characters";
const runtime = new Miniflare({
  workers: [
    {
      config: {
        type: "worker",
        name: "jobs",
        compatibilityDate: "2026-09-10",
        compatibilityFlags: ["nodejs_compat"],
        manifest: {
          mainModule: "index.js",
          modules: {
            "index.js": {
              type: "esm",
              contents: await readFile(new URL("../dist/index.js", import.meta.url), "utf8"),
            },
          },
        },
        env: {
          DB: { type: "d1", id: databaseId },
          MEDIA: { type: "r2", name: "mytuums_jobs_media_test", jurisdiction: "eu" },
          STREAM: { type: "worker", worker: "stream-fixture" },
          EMAIL: { type: "worker", worker: "stream-fixture" },
          WEB_ORIGIN: { type: "json", value: "https://preview.example.test" },
          EMAIL_FROM: { type: "json", value: "noreply@mytuums.com" },
          APPEAL_TOKEN_SECRET: { type: "json", value: appealSecret },
          STREAM_NAMESPACE: { type: "json", value: "mytuums-test" },
          CLOUDFLARE_ACCOUNT_ID: { type: "json", value: "a".repeat(32) },
          STREAM_API_TOKEN: { type: "json", value: "synthetic-test-token" },
          IGDB_CLIENT_ID: { type: "json", value: "synthetic-client" },
          IGDB_CLIENT_SECRET: { type: "json", value: "synthetic-secret" },
          VIDEO_WORKFLOW: {
            type: "workflow",
            name: "video-test",
            worker: "jobs",
            exportName: "VideoWorkflow",
          },
          MAINTENANCE_WORKFLOW: {
            type: "workflow",
            name: "maintenance-test",
            worker: "jobs",
            exportName: "MaintenanceWorkflow",
          },
          GAME_SYNC_WORKFLOW: {
            type: "workflow",
            name: "games-test",
            worker: "jobs",
            exportName: "GameSyncWorkflow",
          },
        },
      },
      dev: {
        outboundService: {
          type: "fetcher",
          async handler(request) {
            const url = new URL(request.url);
            if (url.hostname === "id.twitch.tv")
              return LocalResponse.json({ access_token: "synthetic-token", expires_in: 3600 });
            if (url.hostname === "api.twitch.tv") {
              const offset = Number(url.searchParams.get("after") ?? 0);
              return LocalResponse.json({
                data: Array.from({ length: 100 }, (_, index) => ({
                  id: String(offset + index + 1),
                  name: `Game ${offset + index + 1}`,
                  box_art_url: "",
                  igdb_id: String(offset + index + 1),
                })),
                pagination: offset < 900 ? { cursor: String(offset + 100) } : {},
              });
            }
            if (url.hostname === "images.igdb.com")
              return new LocalResponse(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 16]), {
                headers: { "content-type": "image/jpeg" },
              });
            if (url.hostname === "api.igdb.com") {
              const query = await request.text();
              if (url.pathname === "/v4/popularity_primitives") {
                const offset = Number(/offset (\d+)/.exec(query)?.[1] ?? 0);
                return LocalResponse.json(
                  Array.from({ length: 500 }, (_, index) => ({ game_id: 1001 + offset + index })),
                );
              }
              const ids = /where id = \(([^)]+)\)/.exec(query)?.[1];
              return LocalResponse.json(
                ids
                  ? ids
                      .split(",")
                      .map(Number)
                      .map((id) => ({
                        id,
                        name: `Game ${id}`,
                        slug: `game-${id}`,
                        genres: [],
                        platforms: [],
                        cover: id === 1 ? { image_id: "cover1" } : null,
                      }))
                  : Array.from({ length: 100 }, (_, index) => ({ id: 5001 + index })),
              );
            }
            // Fail closed: the test has no route to the external network.
            return new LocalResponse(null, { status: 502 });
          },
        },
      },
    },
    {
      config: {
        type: "worker",
        name: "stream-fixture",
        compatibilityDate: "2026-09-10",
        manifest: {
          mainModule: "index.js",
          modules: { "index.js": { type: "esm", contents: streamFixture } },
        },
        env: { DB: { type: "d1", id: databaseId } },
      },
    },
  ],
});
const binding = await runtime.getD1Database("DB", "jobs");
const db = createDatabase(binding);
const workflows = await runtime.getBindings<{
  MEDIA: R2Bucket;
  VIDEO_WORKFLOW: Workflow<{ entityId: string }>;
  MAINTENANCE_WORKFLOW: Workflow<{ entityId: string }>;
  GAME_SYNC_WORKFLOW: Workflow<{ entityId: string }>;
}>("jobs");

beforeAll(async () => {
  await migrate(drizzle(binding), {
    migrationsFolder: fileURLToPath(new URL("../../../packages/db/drizzle-d1", import.meta.url)),
  });
  await binding
    .prepare("create table test_caption (uid text primary key, language text, body text)")
    .run();
  await binding.prepare("create table test_email (recipient text, subject text, body text)").run();
});
afterAll(() => runtime.dispose());

async function completed(instance: WorkflowInstance) {
  await expect
    .poll(async () => (await instance.status()).status, { timeout: 20_000 })
    .toBe("complete");
  return instance.status();
}

it("recovers a committed moderation notice through the maintenance Workflow", async () => {
  const userId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const recipient = `${userId}@example.test`;
  await db.insert(user).values({ id: userId, email: recipient, name: "Synthetic mail recipient" });
  await db.insert(moderationEmail).values({
    id: crypto.randomUUID(),
    sourceId,
    userId,
    locale: "fr",
    content: {
      kind: "post_removed",
      postText: "Synthetic committed post",
      attachmentCount: 0,
      reason: "spam",
    },
  });
  const id = `recover-${Date.now()}`;
  const instance = await workflows.MAINTENANCE_WORKFLOW.create({ id, params: { entityId: id } });
  expect((await completed(instance)).output).toEqual({ jobId: id });
  const messages = await binding
    .prepare("select subject, body from test_email where recipient = ?")
    .bind(recipient)
    .all<{ subject: string; body: string }>();
  expect(messages.results).toHaveLength(1);
  expect(messages.results[0].body).toContain("Synthetic committed post");
  expect(messages.results[0].body).toContain("Votre publication");
  expect(messages.results[0].body).toContain("https://preview.example.test/appeal?token=");
  const capability = /\/appeal\?token=([A-Za-z0-9_.-]+)/.exec(messages.results[0].body)?.[1];
  expect(capability).toBeDefined();
  expect(await createAppealTokenSigner(appealSecret).verify(capability!)).toMatchObject({
    actionId: sourceId,
    userId,
    purpose: "appeal",
  });
  expect(await db.select().from(moderationEmail).where(eq(moderationEmail.userId, userId))).toEqual(
    [],
  );
  await instance.restart();
  await completed(instance);
  expect(
    (
      await binding
        .prepare("select count(*) as count from test_email where recipient = ?")
        .bind(recipient)
        .first<{ count: number }>()
    )?.count,
  ).toBe(1);
}, 30_000);

it("executes the bundled video Workflow against D1 and a native stream through RPC", async () => {
  const authorId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const caption = "WEBVTT\n\n00:00.000 --> 00:01.000\nPrivate caption body";
  await db
    .insert(user)
    .values({ id: authorId, email: `${authorId}@example.test`, name: "Synthetic author" });
  await db.batch([
    db.insert(video).values({
      id,
      authorId,
      state: "queued",
      byteSize: 10,
      streamCreatorId: `mytuums-test:${id}`,
      streamUid: id.replaceAll("-", ""),
      expiresAt: new Date(Date.now() + 1_800_000),
    }),
    db.insert(videoSubmission).values({
      videoId: id,
      authorId,
      content: "Private workflow post",
      isPrivate: true,
      caption,
      captionLanguage: "en",
    }),
  ]);
  const instance = await workflows.VIDEO_WORKFLOW.create({
    id: `video-${id}`,
    params: { entityId: id },
  });
  expect((await completed(instance)).output).toEqual({ videoId: id });
  expect(await db.select().from(post)).toMatchObject([
    { content: "Private workflow post", isPrivate: true },
  ]);
  expect(await db.select().from(videoSubmission)).toHaveLength(0);
  expect(await binding.prepare("select language, body from test_caption").all()).toMatchObject({
    results: [{ language: "en", body: caption }],
  });
}, 30_000);

it("executes bounded pruning without deleting moderation notices", async () => {
  const authorId = crypto.randomUUID();
  await db
    .insert(user)
    .values({ id: authorId, email: `${authorId}@example.test`, name: "Synthetic recipient" });
  await binding
    .prepare(
      "insert into notification (id, recipient_id, type, video_id, created_at) select value, ?, 'video_failed', value, 0 from json_each(?)",
    )
    .bind(authorId, JSON.stringify(Array.from({ length: 251 }, () => crypto.randomUUID())))
    .run();
  const [action] = await db
    .insert(moderationAction)
    .values({
      actorId: authorId,
      action: "user_banned",
      targetType: "user",
      targetUserId: authorId,
      reason: "Synthetic moderation",
    })
    .returning();
  await db.insert(notification).values({
    recipientId: authorId,
    type: "moderation",
    actionId: action.id,
    createdAt: new Date(0),
  });
  const id = `prune-${Date.now()}-0`;
  const instance = await workflows.MAINTENANCE_WORKFLOW.create({ id, params: { entityId: id } });
  expect((await completed(instance)).output).toEqual({ jobId: id });
  expect(await db.select().from(notification)).toMatchObject([{ type: "moderation" }]);
}, 30_000);

it("does not expose an HTTP handler", async () => {
  const worker = await runtime.getWorker("jobs");
  await expect(worker.fetch("https://jobs.test/")).rejects.toThrow("does not export a fetch()");
});

it("runs Cron dispatch, deadline recovery and Monday pruning through the scheduled entrypoint", async () => {
  const authorId = crypto.randomUUID();
  const id = crypto.randomUUID();
  await db
    .insert(user)
    .values({ id: authorId, email: `${authorId}@example.test`, name: "Synthetic overdue author" });
  await db.batch([
    db.insert(video).values({
      id,
      authorId,
      state: "queued",
      byteSize: 10,
      streamCreatorId: `mytuums-test:${id}`,
      streamUid: id.replaceAll("-", ""),
      expiresAt: new Date(0),
    }),
    db
      .insert(videoSubmission)
      .values({ videoId: id, authorId, content: "Overdue private submission", isPrivate: true }),
    db.insert(jobIntent).values({ id: `video-${id}`, kind: "video", entityId: id }),
  ]);
  const monday = new Date("2026-09-14T04:00:00.000Z");
  const worker = await runtime.getWorker("jobs");
  expect(await worker.scheduled({ scheduledTime: monday, cron: "* * * * *" })).toMatchObject({
    outcome: "ok",
  });
  await completed(await workflows.VIDEO_WORKFLOW.get(`video-${id}`));
  await completed(await workflows.MAINTENANCE_WORKFLOW.get(`recover-${monday.getTime()}`));
  await completed(await workflows.MAINTENANCE_WORKFLOW.get(`prune-${monday.getTime()}-0`));
  expect(await db.select().from(video).where(eq(video.id, id))).toMatchObject([
    { state: "failed" },
  ]);
  expect(await db.select().from(notification).where(eq(notification.videoId, id))).toHaveLength(1);
  expect(await db.select().from(jobIntent)).toHaveLength(3);
  expect(await worker.scheduled({ scheduledTime: monday, cron: "* * * * *" })).toMatchObject({
    outcome: "ok",
  });
  expect(await db.select().from(jobIntent)).toHaveLength(0);
}, 30_000);

it("runs the daily 5,000-game catalog Workflow with private R2 covers and skips replay", async () => {
  const midnight = new Date("2026-09-15T00:00:00.000Z");
  const id = `games-${midnight.getTime()}`;
  const worker = await runtime.getWorker("jobs");
  expect(await worker.scheduled({ scheduledTime: midnight, cron: "* * * * *" })).toMatchObject({
    outcome: "ok",
  });
  const instance = await workflows.GAME_SYNC_WORKFLOW.get(id);
  expect((await completed(instance)).output).toMatchObject({
    status: "published",
    selected: 5000,
    newGames: 5100,
    coversUploaded: 1,
  });
  const [cover] = await db
    .select({ path: game.coverMediaPath })
    .from(game)
    .where(eq(game.igdbId, 1));
  expect(cover.path).not.toBeNull();
  const stored = await createR2Storage(workflows.MEDIA).get(cover.path!.slice("/media/".length));
  expect(stored).toMatchObject({
    contentType: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 16]),
  });
  const [snapshot] = await db.select().from(gameCatalogState);
  await instance.restart();
  expect((await completed(instance)).output).toEqual({ status: "current" });
  expect(await db.select().from(gameCatalogState)).toEqual([snapshot]);
}, 30_000);

it("cleans R2 debt and reconciles orphans while retaining the live game cover", async () => {
  const storage = createR2Storage(workflows.MEDIA);
  await storage.put("games/90001-obsolete.jpg", new Uint8Array([1]), "image/jpeg");
  await storage.put("games/90002-orphan.jpg", new Uint8Array([2]), "image/jpeg");
  await db.insert(mediaIntent).values({
    scope: "catalog",
    kind: "cleanup",
    paths: ["/media/games/90001-obsolete.jpg"],
    readyAt: new Date(0),
  });
  const id = `recover-${Date.now()}`;
  await completed(await workflows.MAINTENANCE_WORKFLOW.create({ id, params: { entityId: id } }));
  expect(await storage.head("games/90001-obsolete.jpg")).toBeNull();
  expect(await storage.head("games/90002-orphan.jpg")).not.toBeNull();
  const inventory = `inventory-${Date.now()}`;
  await completed(
    await workflows.MAINTENANCE_WORKFLOW.create({ id: inventory, params: { entityId: inventory } }),
  );
  expect(await storage.listByPrefix("games/")).toHaveLength(1);
}, 30_000);

it("paginates R2 listings and deletes more than one provider batch", async () => {
  const storage = createR2Storage(workflows.MEDIA);
  for (let offset = 0; offset < 1001; offset += 50)
    await Promise.all(
      Array.from({ length: Math.min(50, 1001 - offset) }, (_, index) =>
        storage.put(`pagination/${offset + index}`, new Uint8Array([1]), "image/png"),
      ),
    );
  expect(await storage.listByPrefix("pagination/")).toHaveLength(1001);
  expect(await storage.removeByPrefix("pagination/")).toBe(1001);
  expect(await storage.listByPrefix("pagination/")).toEqual([]);
}, 30_000);
