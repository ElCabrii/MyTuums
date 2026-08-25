import { processAnimatedGif, type GifTarget } from "@/lib/gif-pipeline";
import { ImageError } from "@/lib/media-layout";

/**
 * The worker entry point for `gif-pipeline.ts`.
 *
 * A GIF can be hundreds of frames at up to 4096×4096 (post attachments) or
 * 3840×1280 (banners) — decoding, compositing and re-encoding all of them is
 * exactly the kind of work issue #201 requires NOT block "normal UI
 * interaction". Everything expensive happens in `processAnimatedGif`, which
 * has no DOM dependency and is therefore free to run here; this file is only
 * the postMessage plumbing around it.
 *
 * One request in flight per worker instance — `gif-variant-client.ts` creates
 * a fresh worker per call and terminates it after, so there is no request id
 * to correlate multiple in-flight calls against a single worker.
 */

export interface GifWorkerRequest {
  source: ArrayBuffer;
  target: GifTarget;
}

export type GifWorkerResponse =
  | { ok: true; bytes: ArrayBuffer; frameCount: number }
  | { ok: false; problem: "type" | "size" | "decode" };

function postResponse(response: GifWorkerResponse): void {
  if (response.ok) {
    self.postMessage(response, { transfer: [response.bytes] });
  } else {
    self.postMessage(response);
  }
}

self.addEventListener("message", (event: MessageEvent<GifWorkerRequest>) => {
  try {
    const result = processAnimatedGif(event.data.source, event.data.target);
    // Copy into a regular ArrayBuffer so the response is always transferable;
    // `Uint8Array.buffer` is typed as ArrayBufferLike and may otherwise include
    // SharedArrayBuffer in the worker boundary's type.
    const bytes = new Uint8Array(result.bytes.byteLength);
    bytes.set(result.bytes);
    const response: GifWorkerResponse = {
      ok: true,
      bytes: bytes.buffer,
      frameCount: result.frameCount,
    };
    postResponse(response);
  } catch (err) {
    // SAFETY: `processAnimatedGif` only ever throws `ImageError`; a `problem`
    // of "decode" is the safe default for anything else since an `Error`
    // instance itself cannot cross the structured-clone boundary as a class.
    const problem = err instanceof ImageError ? err.problem : "decode";
    const response: GifWorkerResponse = {
      ok: false,
      problem: problem === "type" || problem === "size" ? problem : "decode",
    };
    postResponse(response);
  }
});
