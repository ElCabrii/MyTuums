import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai-family";
import { VIDEO_INPUT_TYPES, VIDEO_MAX_BYTES } from "@my-tuums/api/constants";
import { client } from "@/lib/orpc";
import { store } from "@/lib/store";
import { uploadVideo } from "@/lib/video-upload";

export interface VideoAttachmentInput {
  videoId: string;
}
interface VideoDraft {
  selectionId: string;
  file: File;
  videoId: string | null;
  status: "uploading" | "paused" | "uploaded";
  bytes: number;
  controller: AbortController;
}
export const videoDraftAtomFamily = atomFamily<string, PrimitiveAtom<VideoDraft | null>>(() =>
  atom<VideoDraft | null>(null),
);

function cancelSession(videoId: string): void {
  void client.video.cancel({ videoId }).catch(() => {
    // The persisted session also expires server-side if the client is offline.
    console.warn("Video cancellation will be reconciled by session expiry.");
  });
}

/** Transfer state survives component unmounts; only explicit cancel discards it. */
export const resumeVideoUploadAtomFamily = atomFamily((scope: string) =>
  atom(null, async (get, set) => {
    const draftAtom = videoDraftAtomFamily(scope);
    const draft = get(draftAtom);
    if (!draft || draft.controller.signal.aborted || draft.status === "uploaded") return;
    const current = () =>
      get(draftAtom)?.selectionId === draft.selectionId && !draft.controller.signal.aborted;
    const update = (patch: Partial<VideoDraft>) => {
      const latest = get(draftAtom);
      if (latest && current()) set(draftAtom, { ...latest, ...patch });
    };
    update({ status: "uploading" });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await uploadVideo(draft.file, {
          videoId: get(draftAtom)?.videoId ?? null,
          signal: draft.controller.signal,
          onSession: (videoId) => {
            if (current()) update({ videoId });
            else cancelSession(videoId);
          },
          onProgress: (bytes) => update({ bytes }),
        });
        update({ status: "uploaded", bytes: draft.file.size });
        return;
      } catch {
        if (!current()) return;
        if (attempt < 2)
          await new Promise<void>((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
    update({ status: "paused" });
  }),
);

export const selectVideoAtomFamily = atomFamily((scope: string) =>
  atom(null, (get, set, file: File) => {
    if (
      file.size <= 0 ||
      file.size > VIDEO_MAX_BYTES ||
      !VIDEO_INPUT_TYPES.some((type) => type === file.type)
    )
      return false;
    const previous = get(videoDraftAtomFamily(scope));
    previous?.controller.abort();
    if (previous?.videoId) cancelSession(previous.videoId);
    set(videoDraftAtomFamily(scope), {
      selectionId: crypto.randomUUID(),
      file,
      videoId: null,
      bytes: 0,
      status: "uploading",
      controller: new AbortController(),
    });
    void set(resumeVideoUploadAtomFamily(scope));
    return true;
  }),
);

/** Publication already owns the video; clearing a successful draft must not cancel it. */
export function clearVideoDraft(scope: string, cancel = false): void {
  const draft = store.get(videoDraftAtomFamily(scope));
  draft?.controller.abort();
  store.set(videoDraftAtomFamily(scope), null);
  if (cancel && draft?.videoId) cancelSession(draft.videoId);
}

export function clearVideoUploadFamilies(): void {
  for (const scope of videoDraftAtomFamily.getParams()) {
    clearVideoDraft(scope);
    videoDraftAtomFamily.remove(scope);
  }
  for (const scope of resumeVideoUploadAtomFamily.getParams())
    resumeVideoUploadAtomFamily.remove(scope);
  for (const scope of selectVideoAtomFamily.getParams()) selectVideoAtomFamily.remove(scope);
}
