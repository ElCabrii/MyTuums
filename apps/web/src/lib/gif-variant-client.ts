import type { GifTarget } from "@/lib/gif-pipeline";
import { ImageError } from "@/lib/media-layout";
import type { GifWorkerRequest, GifWorkerResponse } from "@/lib/gif-variant-worker";

/**
 * Runs the animated-GIF codec in a dedicated worker and returns the re-encoded
 * display object. A fresh worker per upload keeps requests independent and
 * lets cancellation terminate the whole decode instead of leaving a queued
 * frame loop alive after the user has moved on.
 */
export async function createAnimatedGifVariant(file: File, target: GifTarget): Promise<File> {
  let source: ArrayBuffer;
  try {
    source = await file.arrayBuffer();
  } catch {
    throw new ImageError("decode");
  }

  return new Promise<File>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./gif-variant-worker.ts", import.meta.url), { type: "module" });
    } catch {
      reject(new ImageError("decode"));
      return;
    }

    let settled = false;
    const finish = (result: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      result();
    };

    worker.onmessage = (event: MessageEvent<GifWorkerResponse>) => {
      const response = event.data;
      if (response.ok) {
        finish(() => resolve(new File([response.bytes], file.name, { type: "image/gif" })));
      } else {
        finish(() => reject(new ImageError(response.problem)));
      }
    };
    worker.onerror = () => finish(() => reject(new ImageError("decode")));
    worker.onmessageerror = () => finish(() => reject(new ImageError("decode")));

    const request: GifWorkerRequest = { source, target };
    try {
      worker.postMessage(request, [source]);
    } catch {
      finish(() => reject(new ImageError("decode")));
    }
  });
}
