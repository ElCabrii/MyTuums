/**
 * S3-compatible object storage, for user-uploaded avatars and banners.
 *
 * Backed by a Railway Storage Bucket in every environment — dev, CI, E2E and
 * production each point at a bucket rather than one of them running a
 * different driver. That is the same bet the rest of this repo makes about
 * Postgres and about the production Better Auth instance: the code path under
 * test should be the code path that ships.
 *
 * Railway buckets are **private**, with no public-bucket option. So nothing
 * here ever hands out a bucket URL. Objects are reached through this app's own
 * `/media/<key>` route, which presigns a short-lived GET and redirects to it
 * (see `apps/server/src/request-handler.ts`). That indirection is what lets the
 * database store a stable `/media/...` path: a presigned URL expires, and one
 * written into a `user` row would rot.
 *
 * This module is a pure factory, exactly like `./rate-limit.ts` — it
 * instantiates nothing of its own. `context.ts` builds the single instance
 * production shares and threads it onto every `Context`, and tests inject their
 * own fake through the same field, so no test ever has to reach a bucket.
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageConfig {
  /** The S3 API endpoint, e.g. `https://storage.railway.app`. */
  endpoint: string;
  /**
   * The globally unique bucket name for the S3 API — Railway's `BUCKET`
   * variable (`my-bucket-jdhhd8oe18xi`), NOT the display name it shows as
   * `RAILWAY_BUCKET_NAME`.
   */
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Railway reports `auto`; kept configurable because the SDK requires one. */
  region?: string;
}

export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Deletes every object under a prefix. Used by the E2E suite's cleanup. */
  removeByPrefix(prefix: string): Promise<number>;
  /** A time-limited URL the browser can fetch the object from directly. */
  signedGetUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

/** One hour. Long enough to be cacheable, far short of the 90-day maximum. */
const DEFAULT_SIGNED_URL_TTL = 3600;

export function createStorage(config: StorageConfig): Storage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? "auto",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Railway buckets use virtual-hosted-style URLs (the bucket name becomes a
    // subdomain of the endpoint), which is the SDK's default. Buckets created
    // before Railway made that the default may need path-style instead; their
    // Credentials tab says which, and this is the one line that would change.
  });

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // Objects are immutable: every upload gets a fresh uuid in its key
          // and the previous one is deleted, so nothing ever serves stale
          // bytes under a key it already served. That is what makes a long
          // browser cache safe on the presigned URL this key is fetched
          // through.
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },

    async removeByPrefix(prefix) {
      let removed = 0;
      let continuationToken: string | undefined;

      // ListObjectsV2 pages at 1000 keys; a test run that uploaded more than
      // that would silently leave the rest behind without this loop.
      do {
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );

        const keys = (listed.Contents ?? [])
          .map((object) => object.Key)
          .filter((key): key is string => typeof key === "string");

        if (keys.length > 0) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: config.bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })) },
            }),
          );
          removed += keys.length;
        }

        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (continuationToken);

      return removed;
    },

    signedGetUrl(key, expiresInSeconds = DEFAULT_SIGNED_URL_TTL) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },
  };
}
