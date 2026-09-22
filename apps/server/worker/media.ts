import {
  parseMediaVariantKey,
  RPC_MAX_BODY_BYTES,
  SERVED_AUDIO_TYPES,
} from "@my-tuums/api/constants";
import { isAllowedImageType, isSafeObjectKey } from "@my-tuums/api/image";

/**
 * What this route may stream back byte-for-byte: the image types (which also
 * feed the variant generator) plus the voice-note audio containers (issue
 * #408) — audio never derives variants and is served exactly as stored. The
 * list is closed; a new stored format extends it in constants together with
 * the upload validator.
 */
function isDeliverableContentType(contentType: string): boolean {
  return isAllowedImageType(contentType) || SERVED_AUDIO_TYPES.some((type) => type === contentType);
}

/** Schedules background work on the request's execution context (issue #405). */
export type WaitUntil = (promise: Promise<unknown>) => void;

export type MediaCacheEvent =
  | { event: "media_cache_hit" }
  | { event: "media_cache_miss" }
  | { event: "media_cache_population_failed" }
  | { event: "image_transform_failed" };

interface MediaDependencies {
  bucket: R2Bucket;
  images: Pick<ImagesBinding, "input">;
  authorize(key: string, viewerId: string | null): Promise<boolean>;
  observe(event: MediaCacheEvent): void;
}

async function imageBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > RPC_MAX_BODY_BYTES) throw new Error("Transformed image exceeds the size limit.");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * How long an eligible edge-cache entry may live (issue #405). Object keys are
 * immutable UUID paths, so bytes cannot go stale under a key; the bound exists
 * only so an entry for a deleted object ages out of the datacenter instead of
 * lingering indefinitely behind an authorization that will never pass again.
 */
const MEDIA_CACHE_TTL_SECONDS = 6 * 60 * 60;

/** A synthetic path prefix that can never collide with a real media object key. */
const MEDIA_CACHE_PATH_PREFIX = "/__media-edge-cache/";

/**
 * Profile originals (`.orig`) are owner-only source material with little
 * repeat-view value; they stay out of the cache. Everything else the resolver
 * serves — post images, profile displays, link-card and game-cover images,
 * plus derived variants — lives under immutable UUID keys.
 */
function cacheEligible(key: string): boolean {
  return !key.includes(".orig");
}

/**
 * The canonical cache key (issue #405): a synthetic GET under the deployment's
 * own origin, built from the object key alone. Cookies, session headers, query
 * strings and viewer identity cannot vary it, because none of them participate
 * in its construction; two authorized viewers in the same datacenter therefore
 * share one entry, while the per-request D1 authorizations remain the only
 * admission decision.
 */
function cacheRequestFor(key: string, request: Request): Request {
  const url = new URL(`${MEDIA_CACHE_PATH_PREFIX}${encodeURIComponent(key)}`, request.url);
  return new Request(url.href, { method: "GET" });
}

/** The browser-facing response is private regardless of what the cache holds. */
function deliveredResponse(
  body: ReadableStream<Uint8Array> | null,
  contentType: string,
  size: number,
): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "content-length": String(size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}

/** Reuse per isolate. Private delivery always inherits the base's current visibility. */
export function createWorkerMediaResolver(deps: MediaDependencies) {
  let generating = false;
  async function objectFor(key: string): Promise<R2ObjectBody | null> {
    const variant = parseMediaVariantKey(key);
    if (!variant) return deps.bucket.get(key);
    const existing = await deps.bucket.get(key);
    if (existing) return existing;
    const base = await deps.bucket.get(variant.baseKey);
    if (!base) return null;
    // Keep animations intact and avoid sending oversized or unexpected objects
    // to the image decoder. Upload validation owns the accepted raster formats.
    const contentType = base.httpMetadata?.contentType;
    if (
      !contentType ||
      !isAllowedImageType(contentType) ||
      contentType === "image/gif" ||
      base.size > RPC_MAX_BODY_BYTES ||
      generating
    )
      return base;

    generating = true;
    let source: ReadableStream<Uint8Array> | undefined;
    let output: ReadableStream<Uint8Array> | undefined;
    try {
      source = base.body.pipeThrough(
        new TransformStream<unknown, Uint8Array>({
          transform(chunk, controller) {
            if (!(chunk instanceof Uint8Array)) throw new Error("Invalid image stream chunk.");
            controller.enqueue(chunk);
          },
        }),
      );
      const transformed = await deps.images
        .input(source)
        .transform({ width: variant.width, fit: "scale-down" })
        .output({ format: "image/webp", quality: 80, anim: false });
      if (transformed.contentType() !== "image/webp") {
        output = transformed.image();
        throw new Error("Unexpected transformed image type.");
      }
      output = transformed.response().body ?? undefined;
      if (!output) throw new Error("Missing transformed image body.");
      // R2 needs a known upload length. Bound the output and allow only one
      // generation per isolate; concurrent misses can safely serve the original.
      // Inventory reconciliation catches a late write after source deletion.
      await deps.bucket.put(key, await imageBytes(output), {
        httpMetadata: { contentType: "image/webp" },
      });
      return (await deps.bucket.get(key)) ?? deps.bucket.get(variant.baseKey);
    } catch {
      // Provider errors can contain private object details. Report only the event;
      // the original is fetched again because Images may have consumed its body.
      try {
        deps.observe({ event: "image_transform_failed" });
      } catch {
        /* Logging must not prevent the original-image fallback. */
      }
      return deps.bucket.get(variant.baseKey);
    } finally {
      generating = false;
      if (source && !source.locked) await source.cancel().catch(() => {});
      if (!base.body.locked) await base.body.cancel().catch(() => {});
      if (output && !output.locked) await output.cancel().catch(() => {});
    }
  }

  return async (
    key: string,
    viewerId: string | null,
    request: Request,
    waitUntil?: WaitUntil,
  ): Promise<Response | null> => {
    if (!isSafeObjectKey(key)) return null;
    const variant = parseMediaVariantKey(key);
    // Structural key validation accepts variant suffixes; only the shared width
    // allowlist may grant transformation work or retrieval of a derived object.
    if (/\.w\d+\.webp$/.test(key) && !variant) return null;
    const baseKey = variant?.baseKey ?? key;
    // Authorization runs before any cache consultation (issue #405): the edge
    // cache can never answer on behalf of the database, only after it.
    if (!(await deps.authorize(baseKey, viewerId))) return null;

    const cacheable = cacheEligible(key);
    const cacheRequest = cacheable ? cacheRequestFor(key, request) : undefined;
    if (cacheRequest) {
      let cached: Response | undefined;
      try {
        cached = await caches.default.match(cacheRequest);
      } catch {
        // Behind Cloudflare Access or on a runtime without the Cache API the
        // resolver must keep serving from R2 exactly as before.
        cached = undefined;
      }
      if (cached?.body) {
        const contentType = cached.headers.get("content-type") ?? "";
        const length = Number(cached.headers.get("content-length"));
        // A block, ban, replacement or deletion during cache lookup must take
        // effect before cached bytes are delivered — the same second
        // authorization the R2 path applies after its I/O.
        if (isDeliverableContentType(contentType) && Number.isSafeInteger(length) && length >= 0) {
          if (!(await deps.authorize(baseKey, viewerId))) {
            await cached.body.cancel().catch(() => {});
            return null;
          }
          try {
            deps.observe({ event: "media_cache_hit" });
          } catch {
            /* Telemetry must not gate delivery. */
          }
          return deliveredResponse(
            request.method === "HEAD" ? null : cached.body,
            contentType,
            length,
          );
        }
        await cached.body.cancel().catch(() => {});
      } else if (cached) {
        try {
          deps.observe({ event: "media_cache_miss" });
        } catch {
          /* Telemetry must not gate delivery. */
        }
      }
    }

    const object = await objectFor(key);
    if (!object) return null;
    let delivered = false;
    try {
      const contentType = object.httpMetadata?.contentType;
      if (!contentType || !isDeliverableContentType(contentType)) return null;
      // A block, ban, replacement or deletion during R2/Images I/O must take
      // effect before we issue the response, including already-cached variants.
      if (!(await deps.authorize(baseKey, viewerId))) return null;
      const head = request.method === "HEAD";
      // The browser gets one branch of the body and the edge cache the other,
      // so population never delays or duplicates the R2 read. Ineligible keys
      // and HEAD requests skip the split and stream the object directly.
      const [outbound, stored] = head
        ? [null, null]
        : cacheRequest
          ? object.body.tee()
          : [object.body, null];
      const response = deliveredResponse(outbound, contentType, object.size);
      delivered = !head;
      if (cacheRequest && stored) {
        // The stored copy is not the browser-facing response: it must carry a
        // cacheable policy or the Cache API refuses to keep it, while every
        // response this resolver returns to a viewer stays private.
        const population = caches.default
          .put(
            cacheRequest,
            new Response(stored, {
              headers: {
                "content-type": contentType,
                "content-length": String(object.size),
                "cache-control": `public, max-age=${MEDIA_CACHE_TTL_SECONDS}`,
              },
            }),
          )
          .catch(() => {
            try {
              deps.observe({ event: "media_cache_population_failed" });
            } catch {
              /* Telemetry must not gate delivery. */
            }
          });
        if (waitUntil) waitUntil(population);
        else await population;
      }
      return response;
    } finally {
      if (!delivered) await object.body.cancel().catch(() => {});
    }
  };
}
