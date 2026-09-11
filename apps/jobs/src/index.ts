import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createDatabase } from "@my-tuums/db";
import {
  advanceStreamVideo,
  cleanStreamUploads,
  createJobDispatcher,
  createStreamService,
  expireStreamProcessing,
  expireStreamUploads,
  failStreamVideo,
  jobIntentInsert,
  pruneExpiredNotifications,
  monitorDispatchedJobs,
  createR2Storage,
  cleanupMediaIntents,
  cleanupExpiredPostMediaUploads,
  cleanupGameCatalogVersions,
  readMediaReferences,
  reconcileMedia,
  syncGamesCatalog,
  createIgdbTransport,
  CatalogAlreadyCurrent,
  cleanupModerationEmails,
  deliverModerationEmails,
  createEmailSender,
  createAppealTokenSigner,
} from "@my-tuums/api/cloudflare-jobs";

type JobParams = { entityId: string };

function streamService(env: Env) {
  return createStreamService({
    binding: env.STREAM,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.STREAM_API_TOKEN,
    namespace: env.STREAM_NAMESPACE,
  });
}

export class VideoWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep) {
    const id = event.payload.entityId;
    // Check external invocations before interpolating identifiers into step names or logs.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error("Invalid video identifier.");
    try {
      // 90 durable sleeps cover the 30-minute deadline. D1 remains the clock
      // authority when queue delay, provider latency or retries consume time.
      for (let poll = 0; poll < 90; poll += 1) {
        const result = await step.do(
          `process-${poll}`,
          {
            retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
            timeout: "2 minutes",
          },
          async () => {
            try {
              const stream = streamService(this.env);
              return await advanceStreamVideo(
                createDatabase(this.env.DB),
                {
                  status: (videoId, uid) => stream.status(videoId, uid),
                  uploadCaptions: (videoId, uid, language, text) =>
                    stream.uploadCaptions(
                      videoId,
                      uid,
                      language,
                      new ReadableStream<Uint8Array>({
                        start(controller) {
                          controller.enqueue(new TextEncoder().encode(text));
                          controller.close();
                        },
                      }),
                    ),
                },
                id,
              );
            } catch {
              throw new Error("Video processing step is temporarily unavailable.");
            }
          },
        );
        if (result === "done") return { videoId: id };
        await step.sleep(`wait-${poll}`, "20 seconds");
      }
    } catch {
      // Retry exhaustion also needs the atomic failure/notice/cleanup transition.
      // Cron deadline recovery covers abrupt termination that cannot run this step.
    }
    await step.do("fail-unfinished-video", async () => {
      try {
        await failStreamVideo(createDatabase(this.env.DB), id);
      } catch {
        throw new Error("Video failure recovery is temporarily unavailable.");
      }
    });
    return { videoId: id };
  }
}

export class GameSyncWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep) {
    const match = /^games-(\d{13})$/.exec(event.payload.entityId);
    if (!match) throw new Error("Invalid game sync identifier.");
    const scheduledAt = new Date(Number(match[1]));
    // No catalog, credential or cover bytes are persisted in Workflow state.
    // D1 stages the full catalog invisibly and fences every publication.
    return step.do(
      "sync-catalog",
      {
        timeout: "30 minutes",
        retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
      },
      async () => {
        try {
          const result = await syncGamesCatalog({
            db: createDatabase(this.env.DB),
            storage: createR2Storage(this.env.MEDIA),
            transport: createIgdbTransport(),
            clientId: this.env.IGDB_CLIENT_ID,
            clientSecret: this.env.IGDB_CLIENT_SECRET,
            now: () => scheduledAt,
            skipIfCurrent: true,
          });
          return { status: "published", ...result };
        } catch (error) {
          if (error instanceof CatalogAlreadyCurrent) return { status: "current" };
        }
        // Unexpected provider/SQL errors are deliberately discarded at this
        // persistence boundary: their causes can contain credentials or data.
        throw new Error("Game catalog sync is temporarily unavailable.");
      },
    );
  }
}

export class MaintenanceWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep) {
    const entityId = event.payload.entityId;
    const prune = /^prune-(\d{13})-(\d{1,9})$/.exec(entityId);
    const inventory = /^inventory-\d{13}$/.test(entityId);
    if (!/^recover-\d{13}$/.test(entityId) && !prune && !inventory)
      throw new Error("Invalid maintenance identifier.");
    const db = createDatabase(this.env.DB);
    if (inventory) {
      await step.do("reconcile-media", { timeout: "15 minutes" }, async () => {
        try {
          return await reconcileMedia({
            storage: createR2Storage(this.env.MEDIA),
            readReferences: () => readMediaReferences(db),
          });
        } catch {
          throw new Error("Media inventory recovery is temporarily unavailable.");
        }
      });
    } else if (prune) {
      // Keep one instance bounded. A full last batch commits continuation intent
      // inside its step, so a lost acknowledgement cannot lose the remaining work.
      for (let batch = 0; batch < 100; batch += 1) {
        const more = await step.do(`prune-${batch}`, async () => {
          try {
            const result = await pruneExpiredNotifications(db);
            if (batch === 99 && result.hasMore) {
              const next = `prune-${prune[1]}-${Number(prune[2]) + 1}`;
              await jobIntentInsert(db, { id: next, kind: "maintenance", entityId: next });
            }
            return result.hasMore;
          } catch {
            throw new Error("Notification pruning is temporarily unavailable.");
          }
        });
        if (!more) break;
      }
    } else {
      await step.do("clean-moderation-email", async () => {
        try {
          return await cleanupModerationEmails(db);
        } catch {
          throw new Error("Moderation email cleanup is temporarily unavailable.");
        }
      });
      await step.do("deliver-moderation-email", { timeout: "2 minutes" }, async () => {
        try {
          return await deliverModerationEmails({
            db,
            emailSender: { send: createEmailSender(this.env.EMAIL, this.env.EMAIL_FROM) },
            webOrigin: this.env.WEB_ORIGIN,
            appealToken: createAppealTokenSigner(this.env.APPEAL_TOKEN_SECRET),
            requestId: entityId,
          });
        } catch {
          throw new Error("Moderation email recovery is temporarily unavailable.");
        }
      });
      await step.do("clean-media", async () => {
        try {
          return await cleanupMediaIntents(db, createR2Storage(this.env.MEDIA));
        } catch {
          throw new Error("Media cleanup is temporarily unavailable.");
        }
      });
      await step.do("expire-post-uploads", async () => {
        try {
          return await cleanupExpiredPostMediaUploads(db, createR2Storage(this.env.MEDIA));
        } catch {
          throw new Error("Post upload cleanup is temporarily unavailable.");
        }
      });
      await step.do("clean-catalog-versions", async () => {
        try {
          await cleanupGameCatalogVersions(db);
        } catch {
          throw new Error("Catalog cleanup is temporarily unavailable.");
        }
      });
      await step.do("expire-processing", async () => {
        try {
          return await expireStreamProcessing(db);
        } catch {
          throw new Error("Video deadline recovery is temporarily unavailable.");
        }
      });
      await step.do("expire-uploads", async () => {
        try {
          return await expireStreamUploads(db);
        } catch {
          throw new Error("Video upload expiry is temporarily unavailable.");
        }
      });
      await step.do(
        "clean-stream",
        {
          timeout: "5 minutes",
          retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
        },
        async () => {
          try {
            return await cleanStreamUploads(db, streamService(this.env));
          } catch {
            throw new Error("Video storage cleanup is temporarily unavailable.");
          }
        },
      );
    }
    return { jobId: entityId };
  }
}

// No fetch handler, workers.dev or preview URL. Cron and bindings are the only entrypoints.
export default {
  async scheduled(controller, env) {
    try {
      const db = createDatabase(env.DB);
      const scheduledAt = new Date(controller.scheduledTime);
      const recoveryId = `recover-${controller.scheduledTime}`;
      await jobIntentInsert(db, { id: recoveryId, kind: "maintenance", entityId: recoveryId });
      if (scheduledAt.getUTCHours() === 0 && scheduledAt.getUTCMinutes() === 0) {
        const gameId = `games-${controller.scheduledTime}`;
        await jobIntentInsert(db, { id: gameId, kind: "game-sync", entityId: gameId });
      }
      if (scheduledAt.getUTCHours() === 3 && scheduledAt.getUTCMinutes() === 0) {
        const inventoryId = `inventory-${controller.scheduledTime}`;
        await jobIntentInsert(db, { id: inventoryId, kind: "maintenance", entityId: inventoryId });
      }
      if (
        scheduledAt.getUTCDay() === 1 &&
        scheduledAt.getUTCHours() === 4 &&
        scheduledAt.getUTCMinutes() === 0
      ) {
        const pruneId = `prune-${controller.scheduledTime}-0`;
        await jobIntentInsert(db, { id: pruneId, kind: "maintenance", entityId: pruneId });
      }
      const workflows = {
        video: env.VIDEO_WORKFLOW,
        maintenance: env.MAINTENANCE_WORKFLOW,
        "game-sync": env.GAME_SYNC_WORKFLOW,
      };
      const monitoring = await monitorDispatchedJobs(db, workflows);
      const dispatch = await createJobDispatcher(db, workflows).recover();
      console.log({ event: "jobs_recovered", monitoring, dispatch });
    } catch {
      throw new Error("Scheduled job recovery is temporarily unavailable.");
    }
  },
} satisfies ExportedHandler<Env>;
