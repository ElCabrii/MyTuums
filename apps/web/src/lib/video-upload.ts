import { client } from "@/lib/orpc";
import { VIDEO_INPUT_TYPES } from "@my-tuums/api/constants";

/** XHR exposes upload progress without reading a source video into JS memory. */
function uploadPart(
  url: string,
  part: Blob,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    request.open("PUT", url);
    request.timeout = 180_000;
    request.upload.onprogress = (event) => progress(event.loaded);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error("The video part could not be uploaded."));
    };
    request.onerror = request.ontimeout = () =>
      reject(new Error("The upload connection was interrupted."));
    request.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    request.onloadend = () => signal.removeEventListener("abort", abort);
    request.send(part);
  });
}

/** Resume from server-confirmed parts, including a completion whose response was lost. */
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
  if (status.state === "uploaded") return videoId;
  if (status.state !== "uploading") throw new Error("This upload is no longer available.");
  const completed = new Set(status.completedParts);
  let bytes = status.completedParts.reduce(
    (total, number) =>
      total + Math.min(status.partBytes, file.size - (number - 1) * status.partBytes),
    0,
  );
  options.onProgress(bytes);
  for (let number = 1; number <= Math.ceil(file.size / status.partBytes); number++) {
    if (completed.has(number)) continue;
    signal.throwIfAborted();
    const { url } = await client.video.part({ videoId, number }, { signal });
    const part = file.slice((number - 1) * status.partBytes, number * status.partBytes);
    await uploadPart(url, part, signal, (loaded) => options.onProgress(bytes + loaded));
    bytes += part.size;
    options.onProgress(bytes);
  }
  signal.throwIfAborted();
  await client.video.finish({ videoId }, { signal });
  return videoId;
}
