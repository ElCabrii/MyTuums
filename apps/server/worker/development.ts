import { WorkerEntrypoint } from "cloudflare:workers";
import { createAuth, type OutgoingEmail } from "@my-tuums/auth";
import { createDatabase } from "@my-tuums/db";
import { createAppealTokenSigner, createR2Storage } from "@my-tuums/api/cloudflare-app";
import { createDistributedRateLimiter } from "@my-tuums/api/distributed-rate-limit";
import { createAuthRateLimitStorage } from "@my-tuums/auth/rate-limit-storage";
import { createWorkerApplication } from "./application.js";
import { createWorkerLinkTransport } from "./link-transport.js";
import { RateLimitCounter } from "./rate-limit-counter.js";
import { AuthRateLimitCounter } from "./auth-rate-limit-counter.js";
export { RateLimitCounter, AuthRateLimitCounter };

const origin = "http://localhost:5173";
const secret = "mytuums-local-development-only-not-a-hosted-secret";
interface DevelopmentEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  IMAGES: ImagesBinding;
  API_COUNTERS: DurableObjectNamespace<RateLimitCounter>;
  AUTH_COUNTERS: DurableObjectNamespace<AuthRateLimitCounter>;
  LINK_FETCHER: Fetcher;
  MAINTENANCE_WORKFLOW: Workflow<{ entityId: string }>;
}

async function captureEmail(env: DevelopmentEnv, email: OutgoingEmail) {
  await env.MEDIA.put(
    `__dev_emails/${Date.now()}-${crypto.randomUUID()}.json`,
    JSON.stringify(email),
  );
}

/** Jobs and auth share the local inbox. This entrypoint is never in a deployment config. */
export class DevelopmentEmail extends WorkerEntrypoint<DevelopmentEnv> {
  async send(email: OutgoingEmail): Promise<void> {
    await captureEmail(this.env, email);
  }
}

async function application(env: DevelopmentEnv) {
  const db = createDatabase(env.DB);
  const sendEmail = (email: OutgoingEmail) => captureEmail(env, email);
  const auth = createAuth({
    db,
    origin,
    secret,
    sendEmail,
    rateLimitStorage: createAuthRateLimitStorage(env.AUTH_COUNTERS),
  });
  return createWorkerApplication({
    auth,
    services: {
      db,
      webOrigin: origin,
      storage: createR2Storage(env.MEDIA),
      videoUploads: null,
      rateLimiter: createDistributedRateLimiter(env.API_COUNTERS),
      emailSender: { send: sendEmail },
      appealToken: createAppealTokenSigner(secret),
      linkTransport: createWorkerLinkTransport(env.LINK_FETCHER),
    },
    bucket: env.MEDIA,
    images: env.IMAGES,
    stream: null,
    streamOrigins: [],
    access: null,
    assets: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) },
  });
}

let handler: ReturnType<typeof application> | undefined;
export default {
  async fetch(request: Request, env: DevelopmentEnv): Promise<Response> {
    const url = new URL(request.url);
    // Local entrypoint admission is independent of and stricter than DNS resolution.
    // It cannot become a hosted Access bypass, even if accidentally uploaded.
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.port !== "3001"
    )
      return new Response(null, { status: 404 });
    if (url.pathname === "/__dev/emails" && request.method === "GET") {
      const objects = await env.MEDIA.list({ prefix: "__dev_emails/", limit: 100 });
      const messages = await Promise.all(
        objects.objects.map(async ({ key }) => {
          const object = await env.MEDIA.get(key);
          return object ? { key, message: await object.json<OutgoingEmail>() } : null;
        }),
      );
      return Response.json(messages, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/__dev/maintenance" && request.method === "POST") {
      if (request.headers.get("x-mytuums-local-dev") !== "1")
        return new Response(null, { status: 403 });
      const id = `recover-${Date.now()}`;
      await env.MAINTENANCE_WORKFLOW.create({ id, params: { entityId: id } });
      return Response.json({ id }, { status: 202 });
    }
    const headers = new Headers(request.headers);
    headers.set("cf-connecting-ip", "127.0.0.1");
    headers.delete("x-mytuums-client-ip");
    handler ??= application(env);
    return (await handler)(
      new Request(`${origin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      }),
    );
  },
};
