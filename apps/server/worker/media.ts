import { parseMediaVariantKey, RPC_MAX_BODY_BYTES } from "@my-tuums/api/constants";
import { isAllowedImageType, isSafeObjectKey } from "@my-tuums/api/image";

interface MediaDependencies {
  bucket: R2Bucket;
  images: Pick<ImagesBinding, "input">;
  authorize(key: string, viewerId: string | null): Promise<boolean>;
  observe(event: { event: "image_transform_failed" }): void;
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
  ): Promise<Response | null> => {
    if (!isSafeObjectKey(key)) return null;
    const variant = parseMediaVariantKey(key);
    // Structural key validation accepts variant suffixes; only the shared width
    // allowlist may grant transformation work or retrieval of a derived object.
    if (/\.w\d+\.webp$/.test(key) && !variant) return null;
    const baseKey = variant?.baseKey ?? key;
    if (!(await deps.authorize(baseKey, viewerId))) return null;
    const object = await objectFor(key);
    if (!object) return null;
    let delivered = false;
    try {
      const contentType = object.httpMetadata?.contentType;
      if (!contentType || !isAllowedImageType(contentType)) return null;
      // A block, ban, replacement or deletion during R2/Images I/O must take
      // effect before we issue the response, including already-cached variants.
      if (!(await deps.authorize(baseKey, viewerId))) return null;
      const head = request.method === "HEAD";
      const response = new Response(head ? null : object.body, {
        headers: {
          "content-type": contentType,
          "content-length": String(object.size),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": "inline",
        },
      });
      delivered = !head;
      return response;
    } finally {
      if (!delivered) await object.body.cancel().catch(() => {});
    }
  };
}
