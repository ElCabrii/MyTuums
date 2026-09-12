import { createWorkerMediaResolver } from "../media.js";

interface Env {
  MEDIA: R2Bucket;
  IMAGES: ImagesBinding;
}

// Synthetic admission decisions isolate delivery from the D1 authorization
// suites. This entrypoint is never a deployment target.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let admissions = 0;
    const base = request.headers.get("x-authorized-key");
    const resolve = createWorkerMediaResolver({
      bucket: env.MEDIA,
      images: request.headers.has("x-fail-images")
        ? {
            input() {
              throw new Error("synthetic provider failure");
            },
          }
        : env.IMAGES,
      authorize(key, viewerId) {
        admissions += 1;
        return Promise.resolve(
          key === base &&
            viewerId === request.headers.get("x-authorized-viewer") &&
            !(request.headers.has("x-revoke") && admissions > 1),
        );
      },
      observe() {},
    });
    return (
      (await resolve(
        new URL(request.url).pathname.slice(1),
        request.headers.get("x-viewer"),
        request,
      )) ?? new Response(null, { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
