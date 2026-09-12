import { client } from "@/lib/orpc";
import { VIDEO_INPUT_TYPES } from "@my-tuums/api/constants";

/** XHR exposes upload progress without reading a source video into JS memory. */
function uploadChunk(
  url: string,
  part: Blob,
  offset: number,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    request.open("PATCH", url);
    request.setRequestHeader("Tus-Resumable", "1.0.0");
    request.setRequestHeader("Upload-Offset", String(offset));
    request.setRequestHeader("Content-Type", "application/offset+octet-stream");
    request.timeout = 180_000;
    request.upload.onprogress = (event) => progress(event.loaded);
    request.onload = () => {
      if (
        request.status === 204 &&
        request.getResponseHeader("Upload-Offset") === String(offset + part.size)
      )
        resolve();
      else reject(new Error("The video part could not be uploaded."));
    };
    request.onerror = request.ontimeout = () =>
      reject(new Error("The upload connection was interrupted."));
    request.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    request.onloadend = () => signal.removeEventListener("abort", abort);
    request.send(part);
  });
}

async function uploadOffset(url: string, byteSize: number, signal: AbortSignal): Promise<number> {
  const response = await fetch(url, {
    method: "HEAD",
    signal,
    credentials: "omit",
    redirect: "error",
    headers: { "Tus-Resumable": "1.0.0" },
  });
  const raw = response.headers.get("Upload-Offset");
  if (
    !response.ok ||
    response.headers.get("Upload-Length") !== String(byteSize) ||
    raw === null ||
    !/^\d+$/.test(raw)
  )
    throw new Error("The upload position could not be verified.");
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset) || offset > byteSize)
    throw new Error("Invalid upload position.");
  return offset;
}

/** Resume from Stream's confirmed offset, including a PATCH whose response was lost. */
export async function uploadVideo(
  file: File,
  options: {
    videoId: string | null;
    signal: AbortSignal;
    onSession: (id: string) => void;
    onProgress: (bytes: number) => void;
  },
): Promise<string> {
  const contentType = VIDEO_INPUT_TYPES.find((type) => type === file.type);
  if (!contentType) throw new Error("Unsupported video container.");
  const { signal } = options;
  let videoId = options.videoId;
  if (!videoId) {
    // Retain the response even if cancellation arrives during begin: the
    // caller needs the assigned ID to cancel its durable storage obligation.
    const session = await client.video.begin({ byteSize: file.size, contentType });
    videoId = session.id;
    options.onSession(videoId);
  }
  signal.throwIfAborted();
  const status = await client.video.status({ videoId }, { signal });
  if (status.byteSize !== file.size) throw new Error("This upload is no longer available.");
  if (status.state === "uploaded") return videoId;
  if (status.state !== "uploading") throw new Error("This upload is no longer available.");
  if (!status.uploadUrl) throw new Error("This upload is no longer available.");
  const chunkBytes = 8 * 1024 * 1024;
  let bytes = await uploadOffset(status.uploadUrl, file.size, signal);
  options.onProgress(bytes);
  while (bytes < file.size) {
    signal.throwIfAborted();
    const part = file.slice(bytes, bytes + chunkBytes);
    await uploadChunk(status.uploadUrl, part, bytes, signal, (loaded) =>
      options.onProgress(bytes + loaded),
    );
    bytes += part.size;
    options.onProgress(bytes);
  }
  signal.throwIfAborted();
  await client.video.finish({ videoId }, { signal });
  return videoId;
}
