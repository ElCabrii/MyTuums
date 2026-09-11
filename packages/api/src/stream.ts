import type {
  StreamBinding,
  ReadableStream as WorkerReadableStream,
} from "@cloudflare/workers-types";
import { z } from "zod";
import { VIDEO_MAX_BYTES, VIDEO_MAX_DURATION_SECONDS } from "./constants.js";

const streamId = z.string().regex(/^[a-f0-9]{32}$/);
const videoIdSchema = z.uuid();
const providerVideos = z.object({
  success: z.literal(true),
  result: z.array(z.object({ uid: streamId, creator: z.string() })).max(100),
});

/** Provider diagnostics, signed capabilities and credentials never enter public errors or logs. */
export class StreamError extends Error {
  constructor(readonly reason: "unavailable" | "invalid_response" | "ownership" | "not_private") {
    super("The video provider could not complete this operation.");
    this.name = "StreamError";
  }
}

/** Upload URLs are capabilities: validate their destination before returning one to a browser. */
export function streamUploadUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StreamError("invalid_response");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(
      url.hostname === "videodelivery.net" ||
      url.hostname.endsWith(".videodelivery.net") ||
      url.hostname === "cloudflarestream.com" ||
      url.hostname.endsWith(".cloudflarestream.com")
    )
  ) {
    throw new StreamError("invalid_response");
  }
  return url.href;
}

async function readBoundedText(response: Response) {
  if (!response.body) throw new StreamError("invalid_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let body = "";
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new StreamError("invalid_response");
      size += value.byteLength;
      if (size > 1024 * 1024) throw new StreamError("invalid_response");
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } catch {
    await reader.cancel().catch(() => {});
    throw new StreamError("invalid_response");
  } finally {
    reader.releaseLock();
  }
}

async function readProviderVideos(response: Response) {
  try {
    return providerVideos.parse(JSON.parse(await readBoundedText(response)));
  } catch {
    throw new StreamError("invalid_response");
  }
}

/**
 * Use native bindings except for tus creation and creator-filtered recovery,
 * which the binding does not expose. The caller records ownership BEFORE
 * createUpload and must recover ambiguous creates by creator ID; never retry a
 * create blindly. Only opaque environment/video IDs are sent as metadata.
 */
export function createStreamService(config: {
  binding: Pick<StreamBinding, "video">;
  accountId: string;
  apiToken: string;
  namespace: string;
  fetch?: typeof fetch;
}) {
  const accountId = streamId.parse(config.accountId);
  const namespace = z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .parse(config.namespace);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`;
  const send = config.fetch ?? fetch;
  const creator = (videoId: string) => `${namespace}:${videoIdSchema.parse(videoId)}`;

  async function request(url: string, init: RequestInit) {
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${config.apiToken}`);
      const response = await send(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new StreamError("unavailable");
      }
      return response;
    } catch {
      throw new StreamError("unavailable");
    }
  }

  async function details(videoId: string, uid: string) {
    const handle = config.binding.video(streamId.parse(uid));
    try {
      const value = await handle.details();
      if (value.id !== uid || value.creator !== creator(videoId))
        throw new StreamError("ownership");
      return value;
    } catch (error) {
      if (error instanceof Error && error.name === "NotFoundError") return null;
      if (error instanceof StreamError) throw error;
      throw new StreamError("unavailable");
    }
  }

  return {
    creatorId: creator,
    async createUpload(videoId: string, byteSize: number, expiresAt: Date) {
      z.number().int().positive().max(VIDEO_MAX_BYTES).parse(byteSize);
      const metadata = [
        "requiresignedurls",
        `maxDurationSeconds ${btoa(String(VIDEO_MAX_DURATION_SECONDS))}`,
        `expiry ${btoa(expiresAt.toISOString())}`,
      ].join(",");
      const response = await request(`${endpoint}?direct_user=true`, {
        method: "POST",
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Length": String(byteSize),
          "Upload-Metadata": metadata,
          "Upload-Creator": creator(videoId),
        },
      });
      const uid = streamId.safeParse(response.headers.get("stream-media-id"));
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!uid.success || !location) throw new StreamError("invalid_response");
      return { uid: uid.data, uploadUrl: streamUploadUrl(location) };
    },
    async status(videoId: string, uid: string) {
      const value = await details(videoId, uid);
      if (!value) return null;
      if (value.requireSignedURLs !== true) throw new StreamError("not_private");
      return {
        uploaded: value.uploaded !== null,
        ready: value.readyToStream,
        failed: value.status.state === "error",
        duration: value.duration,
        width: value.input.width,
        height: value.input.height,
      };
    },
    async uploadCaptions(
      videoId: string,
      uid: string,
      language: string,
      input: WorkerReadableStream<Uint8Array>,
    ) {
      const value = await details(videoId, uid);
      if (!value || value.requireSignedURLs !== true) throw new StreamError("not_private");
      try {
        await config.binding.video(uid).captions.upload(language, input);
      } catch {
        throw new StreamError("unavailable");
      }
    },
    async signedVideoUrl(
      videoId: string,
      uid: string,
      kind: "manifest" | "cover" | "preview",
      time = 0,
    ) {
      const value = await details(videoId, uid);
      if (
        !value ||
        value.requireSignedURLs !== true ||
        !value.readyToStream ||
        value.status.state === "error"
      )
        throw new StreamError("not_private");
      if (!Number.isInteger(time) || time < 0 || time > VIDEO_MAX_DURATION_SECONDS)
        throw new StreamError("invalid_response");
      // Keep only the validated provider origin; do not forward metadata query
      // strings or let a token alter the URL path. Native tokens expire in one hour.
      const origin = new URL(streamUploadUrl(value.hlsPlaybackUrl)).origin;
      let token: string;
      try {
        token = await config.binding.video(uid).generateToken();
      } catch {
        throw new StreamError("unavailable");
      }
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        throw new StreamError("invalid_response");
      const path = kind === "manifest" ? "manifest/video.m3u8" : "thumbnails/thumbnail.jpg";
      const url = new URL(`/${token}/${path}`, origin);
      if (kind !== "manifest") {
        url.searchParams.set("time", `${time}s`);
        url.searchParams.set("width", kind === "preview" ? "160" : "640");
        url.searchParams.set("height", kind === "preview" ? "90" : "640");
        url.searchParams.set("fit", kind === "preview" ? "crop" : "clip");
      }
      return url.href;
    },
    async readCaptions(videoId: string, uid: string, language: string) {
      const value = await details(videoId, uid);
      if (!value || value.requireSignedURLs !== true) throw new StreamError("not_private");
      if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language))
        throw new StreamError("invalid_response");
      const response = await request(
        `${endpoint}/${streamId.parse(uid)}/captions/${language}/vtt`,
        { method: "GET" },
      );
      const text = await readBoundedText(response);
      if (!text.startsWith("WEBVTT")) throw new StreamError("invalid_response");
      return text;
    },
    async remove(videoId: string, uid: string) {
      if (!(await details(videoId, uid))) return;
      try {
        await config.binding.video(uid).delete();
      } catch (error) {
        if (!(error instanceof Error && error.name === "NotFoundError"))
          throw new StreamError("unavailable");
      }
    },
    /** Return one bounded recovery page; the cleanup caller repeats until empty. */
    async findUploads(videoId: string) {
      const expectedCreator = creator(videoId);
      const query = new URLSearchParams({
        creator: expectedCreator,
        limit: "100",
        include_counts: "false",
      });
      const response = await request(`${endpoint}?${query.toString()}`, { method: "GET" });
      const parsed = await readProviderVideos(response);
      if (parsed.result.some((item) => item.creator !== expectedCreator))
        throw new StreamError("ownership");
      return parsed.result.map((item) => item.uid);
    },
  };
}

export type StreamService = ReturnType<typeof createStreamService>;
