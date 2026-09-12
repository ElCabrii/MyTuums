import { z } from "zod";
import { createAuth, createEmailSender } from "@my-tuums/auth";
import { createDatabase } from "@my-tuums/db";
import {
  createAppealTokenSigner,
  createR2Storage,
  createStreamService,
  createVideoUploads,
  createJobDispatcher,
} from "@my-tuums/api/cloudflare-app";
import { createDistributedRateLimiter } from "@my-tuums/api/distributed-rate-limit";
import { createAuthRateLimitStorage } from "@my-tuums/auth/rate-limit-storage";
import { createWorkerApplication } from "./application.js";
export { RateLimitCounter } from "./rate-limit-counter.js";
export { AuthRateLimitCounter } from "./auth-rate-limit-counter.js";

const configuration = z
  .object({
    WEB_ORIGIN: z.enum([
      "https://cf-poc.mytuums.com",
      "https://preview-candidate.mytuums.com",
      "https://preview.mytuums.com",
      "https://mytuums.com",
    ]),
    ACCESS_TEAM_DOMAIN: z.literal("https://mytuums.cloudflareaccess.com"),
    ACCESS_AUDIENCE: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    ACCESS_MODE: z.enum(["required", "public"]).default("required"),
    CLOUDFLARE_ACCOUNT_ID: z.literal("734f3b84571b1967e6940140a0b7d75f"),
    STREAM_NAMESPACE: z.enum(["mytuums-poc", "mytuums-preview", "mytuums-production"]),
    EMAIL_FROM: z.literal("noreply@mytuums.com"),
    GOOGLE_ANALYTICS: z.enum(["enabled", "disabled"]).default("disabled"),
    BETTER_AUTH_SECRET: z.string().min(32),
    APPEAL_TOKEN_SECRET: z.string().min(32),
    STREAM_API_TOKEN: z.string().min(1),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    DISCORD_CLIENT_ID: z.string().min(1),
    DISCORD_CLIENT_SECRET: z.string().min(1),
    TWITCH_CLIENT_ID: z.string().min(1),
    TWITCH_CLIENT_SECRET: z.string().min(1),
  })
  .refine((config) => {
    if (config.WEB_ORIGIN === "https://mytuums.com")
      return config.STREAM_NAMESPACE === "mytuums-production" && config.ACCESS_MODE === "public";
    if (config.ACCESS_MODE !== "required" || !config.ACCESS_AUDIENCE) return false;
    if (config.WEB_ORIGIN === "https://cf-poc.mytuums.com")
      return config.STREAM_NAMESPACE === "mytuums-poc";
    if (config.WEB_ORIGIN === "https://preview.mytuums.com")
      return config.STREAM_NAMESPACE === "mytuums-preview";
    return config.STREAM_NAMESPACE !== "mytuums-poc";
  }, "Origin and Stream namespace must belong to the same environment.");

async function application(env: AppEnv) {
  const config = configuration.parse(env);
  const db = createDatabase(env.DB);
  const sendEmail = createEmailSender(env.EMAIL, config.EMAIL_FROM);
  const stream = createStreamService({
    binding: env.STREAM,
    accountId: config.CLOUDFLARE_ACCOUNT_ID,
    apiToken: config.STREAM_API_TOKEN,
    namespace: config.STREAM_NAMESPACE,
  });
  const jobs = createJobDispatcher(db, { video: env.VIDEO_WORKFLOW });
  const auth = createAuth({
    db,
    origin: config.WEB_ORIGIN,
    secret: config.BETTER_AUTH_SECRET,
    sendEmail,
    rateLimitStorage: createAuthRateLimitStorage(env.AUTH_COUNTERS),
    providers: {
      google: { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET },
      discord: { clientId: config.DISCORD_CLIENT_ID, clientSecret: config.DISCORD_CLIENT_SECRET },
      twitch: { clientId: config.TWITCH_CLIENT_ID, clientSecret: config.TWITCH_CLIENT_SECRET },
    },
  });
  const handle = await createWorkerApplication({
    auth,
    services: {
      db,
      webOrigin: config.WEB_ORIGIN,
      storage: createR2Storage(env.MEDIA),
      videoUploads: createVideoUploads(db, stream, jobs),
      rateLimiter: createDistributedRateLimiter(env.API_COUNTERS),
      appealToken: createAppealTokenSigner(config.APPEAL_TOKEN_SECRET),
      emailSender: { send: sendEmail },
      // Hosted Workers could not complete hostname-verified TLS when connecting
      // to a validated IP. Keep the existing plain-link fallback until a safe
      // transport passes hosted tests; ordinary fetch after DNS preflight is unsafe.
      linkTransport: {
        lookup: () => Promise.reject(new Error("Preview networking unavailable.")),
        fetch: () => Promise.reject(new Error("Preview networking unavailable.")),
      },
    },
    bucket: env.MEDIA,
    images: env.IMAGES,
    stream,
    assets: env.ASSETS,
    googleAnalytics: config.GOOGLE_ANALYTICS === "enabled",
    access:
      config.ACCESS_MODE === "public"
        ? null
        : {
            teamDomain: config.ACCESS_TEAM_DOMAIN,
            audience: z.string().parse(config.ACCESS_AUDIENCE),
          },
    streamOrigins: [
      "https://videodelivery.net",
      "https://*.videodelivery.net",
      "https://cloudflarestream.com",
      "https://*.cloudflarestream.com",
    ],
  });
  return async (request: Request) => {
    const response = await handle(request);
    if (config.ACCESS_MODE === "public") return response;
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("x-robots-tag", "noindex, nofollow");
    return new Response(response.body, { status: response.status, headers });
  };
}

let handler: ReturnType<typeof application> | undefined;
export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    try {
      handler ??= application(env);
      const handle = await handler;
      return await handle(request);
    } catch {
      // Configuration errors can include secrets. Never expose their raw message,
      // cause or validation details; a failed initialization must remain retryable.
      handler = undefined;
      const requestId = crypto.randomUUID();
      console.error({ event: "application_initialization_failed", requestId });
      if (request.body && !request.body.locked) await request.body.cancel().catch(() => {});
      return new Response(request.method === "HEAD" ? null : "Service unavailable", {
        status: 503,
        headers: {
          "cache-control": "private, no-store",
          "x-robots-tag": "noindex, nofollow",
          "x-content-type-options": "nosniff",
          "x-request-id": requestId,
        },
      });
    }
  },
};
