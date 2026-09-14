import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { installTestClient } from "@/lib/orpc";
import type {
  VideoPreflightRejection,
  VideoPreflightVerdict,
  VideoVerifier,
} from "@/lib/video-preflight";
import {
  clearVideoUploadFamilies,
  selectVideoAtomFamily,
  videoDraftAtomFamily,
} from "@/atoms/video-upload";

const FILE_BYTES = 16;
const file = new File([new Uint8Array(FILE_BYTES)], "clip.mp4", { type: "video/mp4" });

/**
 * The selection atom's contract (issue #404): no draft state and no upload
 * attempt before every local check has passed. Verdicts are injected through
 * the atom's verifier argument and the upload session through the sanctioned
 * raw-client seam — no module mocks. The fake provider answers `status`
 * with an already-complete upload so the resumable transport finishes
 * without network I/O.
 */
const begin = vi.fn(() => Promise.resolve({ id: "video-1" }));
const status = vi.fn(() =>
  Promise.resolve({ byteSize: FILE_BYTES, state: "uploaded", uploadUrl: null }),
);
const cancel = vi.fn(() => Promise.resolve());
installTestClient({
  video: { begin, status, cancel },
  // SAFETY: the raw client's procedure surface is wider than this suite
  // touches; the transport under test only calls the video group.
});

/** A verifier pinned to one verdict. */
function verifyingWith(verdict: VideoPreflightVerdict): VideoVerifier {
  return () => Promise.resolve(verdict);
}

beforeEach(() => {
  begin.mockClear();
  status.mockClear();
  cancel.mockClear();
  clearVideoUploadFamilies();
});

describe("selectVideoAtomFamily", () => {
  it("refuses an oversized file synchronously, with no verifier, draft or transport", async () => {
    const store = createStore();
    const oversized = new File([new Uint8Array(8)], "huge.mp4", { type: "video/mp4" });
    Object.defineProperty(oversized, "size", { value: Number.MAX_SAFE_INTEGER });
    const verify = vi.fn<VideoVerifier>();

    await expect(store.set(selectVideoAtomFamily("composer"), oversized, verify)).resolves.toEqual({
      accepted: false,
      reason: "size",
    });
    expect(verify).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(store.get(videoDraftAtomFamily("composer"))).toBeNull();
  });

  it.each([
    ["duration", "duration"],
    ["dimensions", "dimensions"],
    ["frame rate", "frameRate"],
    ["unreadable metadata", "unreadable"],
  ] as const satisfies readonly (readonly [string, VideoPreflightRejection])[])(
    "creates no draft and never uploads when the preflight refuses the %s",
    async (_kind, reason) => {
      const store = createStore();

      await expect(
        store.set(selectVideoAtomFamily("composer"), file, verifyingWith({ ok: false, reason })),
      ).resolves.toEqual({ accepted: false, reason });
      expect(begin).not.toHaveBeenCalled();
      expect(store.get(videoDraftAtomFamily("composer"))).toBeNull();
    },
  );

  it("creates the draft and starts the resumable upload only after acceptance", async () => {
    const store = createStore();

    await expect(
      store.set(selectVideoAtomFamily("composer"), file, verifyingWith({ ok: true })),
    ).resolves.toEqual({ accepted: true });
    expect(store.get(videoDraftAtomFamily("composer"))?.file).toBe(file);
    await vi.waitFor(() => expect(begin).toHaveBeenCalledTimes(1));
    expect(status).toHaveBeenCalledWith({ videoId: "video-1" }, expect.anything());
    // The transport completed against the synthetic provider: the draft
    // settles as uploaded with the file's full size accounted.
    await vi.waitFor(() =>
      expect(store.get(videoDraftAtomFamily("composer"))).toMatchObject({
        status: "uploaded",
        videoId: "video-1",
        bytes: FILE_BYTES,
      }),
    );
  });
});
