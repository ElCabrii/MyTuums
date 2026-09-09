import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createDestructiveStorage, type StorageConfig } from "./storage.js";

export const VIDEO_PART_BYTES = 8 * 1024 * 1024;
export const VIDEO_PART_URL_SECONDS = 15 * 60;

export interface VideoPart {
  number: number;
  byteSize: number;
  etag: string;
}

/** The request-facing capability cannot enumerate or recursively delete a bucket. */
export interface VideoUploadStorage {
  startMultipart(key: string): Promise<string>;
  signPart(key: string, uploadId: string, number: number, byteSize: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<VideoPart[]>;
  completeMultipart(key: string, uploadId: string, parts: VideoPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  sourceSize(key: string): Promise<number | null>;
}

/** Only the worker receives streaming transfer and reconciliation capabilities. */
export interface VideoStorage extends VideoUploadStorage {
  readSource(key: string, signal: AbortSignal): Promise<{ body: Readable; byteSize: number }>;
  putAsset(
    key: string,
    body: Readable,
    byteSize: number,
    contentType: string,
    signal: AbortSignal,
  ): Promise<void>;
  remove(key: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
  listKeys(): Promise<string[]>;
  listMultipart(): Promise<{ key: string; uploadId: string; createdAt: Date }[]>;
}

function requireVideoKey(key: string): void {
  if (!/^videos\/[0-9a-f-]{36}\/(?:source|attempts\/[0-9a-f-]{36}\/[a-z0-9_.-]+)?$/.test(key)) {
    throw new Error("Invalid video storage key.");
  }
}

/** Same private bucket and SDK as images; source bytes never buffer in the API. */
export function createVideoStorage(config: StorageConfig): VideoStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? "auto",
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const bucket = config.bucket;
  const cleanup = createDestructiveStorage(config);
  return {
    async startMultipart(key) {
      requireVideoKey(key);
      const result = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: "application/octet-stream",
          CacheControl: "no-store",
        }),
      );
      if (!result.UploadId) throw new Error("Storage did not create a multipart upload.");
      return result.UploadId;
    },
    signPart(key, uploadId, number, byteSize) {
      requireVideoKey(key);
      return getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: number,
          ContentLength: byteSize,
        }),
        { expiresIn: VIDEO_PART_URL_SECONDS, signableHeaders: new Set(["content-length"]) },
      );
    },
    async listParts(key, uploadId) {
      requireVideoKey(key);
      const parts: VideoPart[] = [];
      let marker: string | undefined;
      do {
        const result = await client.send(
          new ListPartsCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of result.Parts ?? []) {
          if (!part.PartNumber || part.Size === undefined || !part.ETag)
            throw new Error("Storage returned incomplete part metadata.");
          parts.push({ number: part.PartNumber, byteSize: part.Size, etag: part.ETag });
        }
        if (result.IsTruncated && !result.NextPartNumberMarker)
          throw new Error("Storage omitted the next part page.");
        marker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
      } while (marker);
      return parts;
    },
    async completeMultipart(key, uploadId, parts) {
      requireVideoKey(key);
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({ PartNumber: part.number, ETag: part.etag })),
          },
        }),
      );
    },
    async abortMultipart(key, uploadId) {
      requireVideoKey(key);
      try {
        await client.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
        );
        // An in-flight part can outlive an abort. Keep the cleanup obligation
        // until the provider no longer exposes this multipart upload.
        await this.listParts(key, uploadId);
        throw new Error("Multipart upload deletion is not yet confirmed.");
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "NoSuchUpload") throw error;
      }
    },
    async sourceSize(key) {
      requireVideoKey(key);
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        if (result.ContentLength === undefined) throw new Error("Storage omitted the source size.");
        return result.ContentLength;
      } catch (error) {
        if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey"))
          return null;
        throw error;
      }
    },
    async readSource(key, signal) {
      requireVideoKey(key);
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: signal,
      });
      if (!(result.Body instanceof Readable))
        throw new Error("Storage did not return a source stream.");
      if (result.ContentLength === undefined) {
        result.Body.destroy();
        throw new Error("Storage omitted the source size.");
      }
      return { body: result.Body, byteSize: result.ContentLength };
    },
    async putAsset(key, body, byteSize, contentType, signal) {
      requireVideoKey(key);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: byteSize,
          ContentType: contentType,
          CacheControl: "public, max-age=31536000, immutable",
        }),
        { abortSignal: signal },
      );
    },
    remove(key) {
      requireVideoKey(key);
      return cleanup.remove(key);
    },
    async removePrefix(prefix) {
      if (!/^videos\/[0-9a-f-]{36}\/(?:attempts\/[0-9a-f-]{36}\/)?$/.test(prefix))
        throw new Error("Invalid video cleanup prefix.");
      await cleanup.removeByPrefix(prefix);
      if ((await cleanup.listByPrefix(prefix)).length)
        throw new Error("Video object deletion is not yet confirmed.");
    },
    listKeys() {
      return cleanup.listByPrefix("videos/");
    },
    async listMultipart() {
      const uploads: { key: string; uploadId: string; createdAt: Date }[] = [];
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      do {
        const result = await client.send(
          new ListMultipartUploadsCommand({
            Bucket: bucket,
            Prefix: "videos/",
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          }),
        );
        for (const upload of result.Uploads ?? []) {
          if (!upload.Key || !upload.UploadId || !upload.Initiated)
            throw new Error("Storage returned incomplete multipart metadata.");
          uploads.push({ key: upload.Key, uploadId: upload.UploadId, createdAt: upload.Initiated });
        }
        if (result.IsTruncated && !result.NextKeyMarker)
          throw new Error("Storage omitted the next multipart page.");
        keyMarker = result.IsTruncated ? result.NextKeyMarker : undefined;
        uploadIdMarker = result.IsTruncated ? result.NextUploadIdMarker : undefined;
      } while (keyMarker);
      return uploads;
    },
  };
}
