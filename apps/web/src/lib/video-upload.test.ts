import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uploadVideo } from "./video-upload";
import { client, installTestClient } from "./orpc";

const originalClient = client;
const rpc = { begin: vi.fn(), status: vi.fn(), finish: vi.fn() };
const chunkBytes = 8 * 1024 * 1024;
const videoId = "11111111-1111-4111-8111-111111111111";
const url = "https://upload.videodelivery.net/tus/synthetic";
let offset: number;
let loseNextAck: boolean;
let file: File;
let patches: { offset: number; size: number }[];

interface UploadProgress {
  onprogress?: (event: { loaded: number }) => void;
}

class UploadRequest {
  upload: UploadProgress = {};
  status = 0;
  timeout = 0;
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  onloadend?: () => void;
  private headers = new Headers();
  open(method: string, target: string) {
    expect(method).toBe("PATCH");
    expect(target).toBe(url);
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }
  getResponseHeader(name: string) {
    return name === "Upload-Offset" ? String(offset) : null;
  }
  abort() {
    this.onabort?.();
    this.onloadend?.();
  }
  send(body: Blob) {
    expect(this.headers.get("Tus-Resumable")).toBe("1.0.0");
    expect(this.headers.get("Content-Type")).toBe("application/offset+octet-stream");
    expect(this.headers.get("Upload-Offset")).toBe(String(offset));
    patches.push({ offset, size: body.size });
    offset += body.size;
    queueMicrotask(() => {
      this.upload.onprogress?.({ loaded: body.size });
      if (loseNextAck) {
        loseNextAck = false;
        this.onerror?.();
      } else {
        this.status = 204;
        this.onload?.();
      }
      this.onloadend?.();
    });
  }
}

beforeEach(() => {
  installTestClient({ video: rpc });
  offset = 0;
  loseNextAck = false;
  patches = [];
  file = new File([new Uint8Array(chunkBytes * 2 + 3)], "video.mp4", { type: "video/mp4" });
  rpc.begin.mockReset().mockResolvedValue({ id: videoId });
  rpc.status
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve({ id: videoId, state: "uploading", uploadUrl: url, byteSize: file.size }),
    );
  rpc.finish.mockReset().mockResolvedValue({ id: videoId, state: "uploaded" });
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  vi.stubGlobal("fetch", (_url: string, options: RequestInit) => {
    expect(options.method).toBe("HEAD");
    return Promise.resolve(
      new Response(null, {
        headers: { "Upload-Offset": String(offset), "Upload-Length": String(file.size) },
      }),
    );
  });
});
afterEach(() => {
  installTestClient(originalClient);
  vi.unstubAllGlobals();
});

it("resumes after a lost PATCH acknowledgement from the provider-confirmed offset", async () => {
  loseNextAck = true;
  let assigned: string | null = null;
  const progress: number[] = [];
  const options = {
    videoId: assigned,
    signal: new AbortController().signal,
    onSession: (id: string) => {
      assigned = id;
    },
    onProgress: (bytes: number) => {
      progress.push(bytes);
    },
  };
  await expect(uploadVideo(file, options)).rejects.toThrow("interrupted");
  expect(assigned).toBe(videoId);
  expect(await uploadVideo(file, { ...options, videoId: assigned })).toBe(videoId);
  expect(patches).toEqual([
    { offset: 0, size: chunkBytes },
    { offset: chunkBytes, size: chunkBytes },
    { offset: chunkBytes * 2, size: 3 },
  ]);
  expect(progress.at(-1)).toBe(file.size);
  expect(rpc.finish).toHaveBeenCalledOnce();
});

it("retains the allocated ID if cancellation arrives during upload creation", async () => {
  const controller = new AbortController();
  const allocated: string[] = [];
  await expect(
    uploadVideo(file, {
      videoId: null,
      signal: controller.signal,
      onSession: (id) => {
        allocated.push(id);
        controller.abort();
      },
      onProgress: () => {},
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(allocated).toEqual([videoId]);
  expect(patches).toHaveLength(0);
});

it("refuses a provider offset outside the selected file before sending any bytes", async () => {
  offset = file.size + 1;
  await expect(
    uploadVideo(file, {
      videoId,
      signal: new AbortController().signal,
      onSession: () => {},
      onProgress: () => {},
    }),
  ).rejects.toThrow("Invalid upload position");
  expect(patches).toHaveLength(0);
});
