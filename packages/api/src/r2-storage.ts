import { RPC_MAX_BODY_BYTES } from "./constants.js";
import type { ObjectStorageMaintenance } from "./object-storage.js";

// Only the R2 operations consumed here belong in the binding contract. In
// particular, unused HTTP-header methods differ between workerd and Miniflare's
// Node proxy and must not force callers to cast the entire bucket unsafely.
interface R2ImageObject {
  httpMetadata?: { contentType?: string };
}
interface R2StorageBinding {
  put(
    key: string,
    bytes: Uint8Array,
    options: { httpMetadata: { contentType: string } },
  ): Promise<R2ImageObject | null>;
  head(key: string): Promise<R2ImageObject | null>;
  get(key: string): Promise<
    | (R2ImageObject & {
        size: number;
        body: { cancel(): Promise<void> };
        arrayBuffer(): Promise<ArrayBuffer>;
      })
    | null
  >;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor: string | undefined; limit: number }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/** Native object operations. Delivery stays behind the app's media authorization. */
export type R2Storage = ObjectStorageMaintenance;

/** No S3 client, account credentials, public bucket or expiring object URL. */
export function createR2Storage(bucket: R2StorageBinding): R2Storage {
  return {
    async put(key, bytes, contentType) {
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    remove: (key) => bucket.delete(key),
    async head(key) {
      const object = await bucket.head(key);
      return object
        ? { contentType: object.httpMetadata?.contentType ?? "application/octet-stream" }
        : null;
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      // This buffered API exists for image transforms. Source uploads already
      // obey the smaller slot limits; unexpected large objects must not exhaust
      // Worker memory. HTTP delivery will use the bucket's streaming body.
      if (object.size > RPC_MAX_BODY_BYTES) {
        await object.body.cancel();
        throw new Error("Stored image exceeds the processing size limit.");
      }
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      };
    },
    async listByPrefix(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      while (true) {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        for (const object of page.objects) keys.push(object.key);
        if (!page.truncated) return keys;
        if (!page.cursor || page.cursor === cursor) throw new Error("R2 listing did not advance.");
        cursor = page.cursor;
      }
    },
    async removeMany(keys) {
      const unique = [...new Set(keys)];
      for (let offset = 0; offset < unique.length; offset += 1000)
        await bucket.delete(unique.slice(offset, offset + 1000));
      // R2 rejects a failed deletion; resolving means every requested key is absent.
      return unique.length;
    },
    async removeByPrefix(prefix) {
      return this.removeMany(await this.listByPrefix(prefix));
    },
  };
}
