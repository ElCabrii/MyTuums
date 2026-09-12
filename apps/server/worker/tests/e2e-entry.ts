import { createAuth, type OutgoingEmail } from "@my-tuums/auth";
import { createDatabase } from "@my-tuums/db";
import {
  createAppealTokenSigner,
  createR2Storage,
  createStreamService,
  createVideoUploads,
  createJobDispatcher,
} from "@my-tuums/api/cloudflare-app";
import { createDistributedRateLimiter } from "@my-tuums/api/distributed-rate-limit";
import { createWorkerApplication } from "../application.js";
import { RateLimitCounter } from "../rate-limit-counter.js";
import {
  E2E_ACCESS_AUDIENCE,
  E2E_ACCESS_ISSUER,
  E2E_AUTH_SECRET,
  E2E_WEB_ORIGIN,
} from "../../../../e2e/constants.js";
import {
  E2E_STREAM_ACCOUNT,
  E2E_STREAM_NAMESPACE,
  E2E_STREAM_TOKEN,
  E2E_STREAM_ORIGIN,
} from "../../../../e2e/stream-fixture.js";
export { RateLimitCounter };

interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  IMAGES: ImagesBinding;
  API_COUNTERS: DurableObjectNamespace<RateLimitCounter>;
  ASSETS: Fetcher;
  ACCESS_TOKEN: string;
  STREAM: StreamBinding;
  VIDEO_WORKFLOW: Workflow<{ entityId: string }>;
}

async function application(env: Env) {
  const db = createDatabase(env.DB);
  const sendEmail = async (email: OutgoingEmail) => {
    await env.MEDIA.put(`__e2e_emails/${crypto.randomUUID()}.json`, JSON.stringify(email));
  };
  const stream = createStreamService({
    binding: env.STREAM,
    accountId: E2E_STREAM_ACCOUNT,
    apiToken: E2E_STREAM_TOKEN,
    namespace: E2E_STREAM_NAMESPACE,
  });
  const auth = createAuth({
    db,
    origin: E2E_WEB_ORIGIN,
    secret: E2E_AUTH_SECRET,
    sendEmail,
    // One browser client drives every account. Native counter enforcement is
    // covered separately; this preserves the existing E2E harness policy.
    rateLimitEnabled: false,
    providers: {
      google: { clientId: "synthetic-google", clientSecret: "synthetic-google" },
      discord: { clientId: "synthetic-discord", clientSecret: "synthetic-discord" },
      twitch: { clientId: "synthetic-twitch", clientSecret: "synthetic-twitch" },
    },
  });
  return createWorkerApplication({
    auth,
    services: {
      db,
      webOrigin: E2E_WEB_ORIGIN,
      storage: createR2Storage(env.MEDIA),
      rateLimiter: createDistributedRateLimiter(env.API_COUNTERS),
      appealToken: createAppealTokenSigner(E2E_AUTH_SECRET),
      emailSender: { send: sendEmail },
      videoUploads: createVideoUploads(
        db,
        stream,
        createJobDispatcher(db, { video: env.VIDEO_WORKFLOW }),
      ),
      linkTransport: {
        lookup: () =>
          Promise.reject(new Error("External previews are unavailable in this fixture.")),
        fetch: () =>
          Promise.reject(new Error("External previews are unavailable in this fixture.")),
      },
    },
    bucket: env.MEDIA,
    images: env.IMAGES,
    stream,
    assets: env.ASSETS,
    access: { teamDomain: E2E_ACCESS_ISSUER, audience: E2E_ACCESS_AUDIENCE },
    streamOrigins: [E2E_STREAM_ORIGIN],
  });
}

let handler: ReturnType<typeof application> | undefined;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "3101") {
      return new Response(null, { status: 404 });
    }
    // This loopback-only fixture stands in for an authenticated Access edge.
    // The real application's signature verification still runs. Production
    // entrypoint tests separately prove missing/invalid assertions are denied.
    const headers = new Headers(request.headers);
    headers.set("cf-access-jwt-assertion", env.ACCESS_TOKEN);
    headers.set("cf-connecting-ip", "127.0.0.1");
    headers.delete("x-mytuums-client-ip");
    handler ??= application(env);
    const handle = await handler;
    return handle(
      new Request(`${E2E_WEB_ORIGIN}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      }),
    );
  },
};
