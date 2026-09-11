import { createAuth, type OutgoingEmail } from "@my-tuums/auth";
import { createDatabase } from "@my-tuums/db";
import { createAppealTokenSigner, createR2Storage } from "@my-tuums/api/cloudflare-app";
import { createDistributedRateLimiter } from "@my-tuums/api/distributed-rate-limit";
import { createAuthRateLimitStorage } from "@my-tuums/auth/rate-limit-storage";
import { createWorkerApplication } from "../application.js";
import { RateLimitCounter } from "../rate-limit-counter.js";
import { AuthRateLimitCounter } from "../auth-rate-limit-counter.js";
export { RateLimitCounter, AuthRateLimitCounter };

interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  IMAGES: ImagesBinding;
  API_COUNTERS: DurableObjectNamespace<RateLimitCounter>;
  AUTH_COUNTERS: DurableObjectNamespace<AuthRateLimitCounter>;
}

// Synthetic delivery and network refusal surround the real RPC/auth/media services.
// This fixture tests local bindings only; it is never a deployment target.
const emails: OutgoingEmail[] = [];
async function application(env: Env) {
  const db = createDatabase(env.DB);
  const webOrigin = "https://rpc-poc.example.test";
  const secret = "native-rpc-media-test-secret-at-least-32-chars";
  const sendEmail = (email: OutgoingEmail) => {
    emails.push(email);
    return Promise.resolve();
  };
  const auth = createAuth({
    db,
    origin: webOrigin,
    secret,
    sendEmail,
    rateLimitStorage: createAuthRateLimitStorage(env.AUTH_COUNTERS),
  });
  const services = {
    db,
    webOrigin,
    storage: createR2Storage(env.MEDIA),
    rateLimiter: createDistributedRateLimiter(env.API_COUNTERS),
    appealToken: createAppealTokenSigner(secret),
    emailSender: { send: sendEmail },
    videoUploads: null,
    linkTransport: {
      lookup: () => Promise.reject(new Error("External requests are outside this fixture.")),
      fetch: () => Promise.reject(new Error("External requests are outside this fixture.")),
    },
  };
  const handle = await createWorkerApplication({
    auth,
    services,
    bucket: env.MEDIA,
    images: env.IMAGES,
    stream: null,
    access: { teamDomain: "https://synthetic-team.cloudflareaccess.com", audience: "a".repeat(64) },
    streamOrigins: [],
    assets: {
      fetch: (request) =>
        Promise.resolve(
          new URL(request.url).pathname === "/index.html"
            ? new Response(
                "<html><!-- app-head-fallback-start --><!-- app-head-fallback-end -->synthetic shell</html>",
                { headers: { "content-type": "text/html" } },
              )
            : new Response(null, { status: 404 }),
        ),
    },
  });
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/captured-emails") return Response.json(emails);
    if (path === "/probe-auth") {
      // Instrument the incoming stream inside workerd; an HTTP client can upload
      // ahead independently, so observing client writes would not prove lazy parsing.
      const results = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        let pulls = 0;
        let cancelled = false;
        const headers = new Headers(request.headers);
        headers.set("cf-connecting-ip", "203.0.113.99");
        headers.set("content-type", "application/json");
        headers.set("origin", webOrigin);
        headers.delete("content-length");
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue(new TextEncoder().encode("{}"));
              controller.close();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
        const response = await handle(
          new Request(`${webOrigin}/api/auth/sign-in/email`, {
            method: "POST",
            headers,
            body,
          }),
        );
        await response.body?.cancel();
        results.push({ status: response.status, pulls, cancelled });
      }
      let pulls = 0;
      let cancelled = false;
      const headers = new Headers(request.headers);
      headers.set("cf-connecting-ip", "203.0.113.98");
      headers.set("content-type", "application/json");
      headers.set("origin", webOrigin);
      headers.delete("content-length");
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(128 * 1024).fill(32));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const oversized = await handle(
        new Request(`${webOrigin}/api/auth/sign-in/email`, {
          method: "POST",
          headers,
          body,
        }),
      );
      await oversized.body?.cancel();
      return Response.json({
        admission: results,
        oversized: { status: oversized.status, pulls, cancelled },
      });
    }
    return handle(request);
  };
}
let handle: Awaited<ReturnType<typeof application>> | undefined;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    handle ??= await application(env);
    return handle(request);
  },
};
