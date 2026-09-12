import type { Auth } from "@my-tuums/auth";
import { pingDb } from "@my-tuums/db";
import {
  type ApiServices,
  type StreamService,
  canViewPostMedia,
  canViewProfileMedia,
  canViewLinkCardMedia,
  canViewGameCoverMedia,
  resolveVideoMedia,
} from "@my-tuums/api/cloudflare-app";
import { createAccessVerifier } from "../src/access.js";
import { createWorkerRequestHandler } from "../src/worker-request-handler.js";
import { createWorkerDocumentTransform } from "../src/worker-document.js";
import { createPublicHeadTransform } from "../src/public-heads.js";
import { workerResponseHeaders } from "../src/worker-response-headers.js";
import { createWorkerApi } from "./api.js";
import { createWorkerMediaResolver } from "./media.js";

/** Compose one environment's services behind the mandatory HTTP security boundary. */
export async function createWorkerApplication(options: {
  auth: Auth;
  services: ApiServices;
  assets: { fetch(request: Request): Promise<Response> };
  bucket: R2Bucket;
  images: ImagesBinding;
  stream: StreamService | null;
  /** Null is reserved for the validated public production origin. */
  access: { teamDomain: string; audience: string } | null;
  streamOrigins: readonly string[];
  googleAnalytics?: boolean;
}) {
  const { auth, services } = options;
  const { db, webOrigin } = services;
  const images = createWorkerMediaResolver({
    bucket: options.bucket,
    images: options.images,
    async authorize(key, viewerId) {
      if (key.startsWith("posts/")) return canViewPostMedia(db, key, viewerId);
      if (key.startsWith("link-cards/")) return canViewLinkCardMedia();
      if (key.startsWith("games/")) return canViewGameCoverMedia();
      return canViewProfileMedia(db, key, viewerId);
    },
    observe: (event) => console.error(event),
  });
  return createWorkerRequestHandler({
    origin: webOrigin,
    authorizeAccess: options.access
      ? createAccessVerifier(options.access)
      : () => Promise.resolve(true),
    pingDb: () => pingDb(db),
    async resolveSession(request) {
      try {
        const session = await auth.api.getSession({ headers: request.headers });
        return session ? { kind: "authenticated", userId: session.user.id } : { kind: "anonymous" };
      } catch {
        return { kind: "unavailable" };
      }
    },
    handleAuth: (request) => auth.handler(request),
    handleRpc: createWorkerApi(auth, services),
    async resolveMedia(key, viewerId, request) {
      if (!key.startsWith("videos/")) return images(key, viewerId, request);
      const media = await resolveVideoMedia(db, options.stream, key, viewerId);
      if (!media) return null;
      const headers = { "cache-control": "private, no-store" };
      if ("url" in media)
        return new Response(null, { status: 302, headers: { ...headers, location: media.url } });
      return new Response(media.body, {
        headers: { ...headers, "content-type": media.contentType },
      });
    },
    fetchAsset: (request) => options.assets.fetch(request),
    transformDocument: createWorkerDocumentTransform(createPublicHeadTransform(db, webOrigin)),
    responseHeaders: await workerResponseHeaders(options),
    observe: (event) => console.error(event),
  });
}
