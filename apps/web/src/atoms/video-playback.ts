import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { jsonStorage } from "@/lib/json-storage";
import { z } from "zod";

const storedAutoplayAtom = atomWithStorage<unknown>(
  "my-tuums.video-autoplay",
  true,
  jsonStorage(),
  { getOnInit: true },
);
export const videoAutoplayAtom = atom(
  (get) => {
    const parsed = z.boolean().safeParse(get(storedAutoplayAtom));
    return parsed.success ? parsed.data : true;
  },
  (_get, set, value: boolean) => set(storedAutoplayAtom, value),
);

interface Candidate {
  ratio: number;
  pausedByUser: boolean;
  autoplay: boolean;
}
export const videoCandidatesAtom = atom(new Map<string, Candidate>());
export const requestedVideoAtom = atom<string | null>(null);
export const activeVideoAtom = atom((get) => {
  const candidates = get(videoCandidatesAtom);
  const requested = get(requestedVideoAtom);
  const selected = requested ? candidates.get(requested) : undefined;
  if (selected && selected.ratio > 0 && !selected.pausedByUser) return requested;
  if (!get(videoAutoplayAtom)) return null;
  let best: string | null = null;
  let ratio = 0.5;
  for (const [id, candidate] of candidates) {
    if (candidate.autoplay && !candidate.pausedByUser && candidate.ratio >= ratio) {
      best = id;
      ratio = candidate.ratio;
    }
  }
  return best;
});

/** Keep the last explicitly paused stream warm until it leaves view or another plays. */
export const videoSourceOwnerAtom = atom((get) => {
  const active = get(activeVideoAtom);
  if (active) return active;
  const requested = get(requestedVideoAtom);
  return requested && (get(videoCandidatesAtom).get(requested)?.ratio ?? 0) > 0 ? requested : null;
});

export const updateVideoVisibilityAtom = atom(
  null,
  (
    get,
    set,
    update: { id: string; ratio: number; autoplay?: boolean } | { id: string; remove: true },
  ) => {
    const candidates = new Map(get(videoCandidatesAtom));
    if ("remove" in update) candidates.delete(update.id);
    else
      candidates.set(update.id, {
        ratio: update.ratio,
        pausedByUser: candidates.get(update.id)?.pausedByUser ?? false,
        autoplay: update.autoplay ?? candidates.get(update.id)?.autoplay ?? true,
      });
    set(videoCandidatesAtom, candidates);
    if (get(requestedVideoAtom) === update.id && ("remove" in update || update.ratio === 0))
      set(requestedVideoAtom, null);
  },
);

export const requestVideoPlaybackAtom = atom(
  null,
  (get, set, request: { id: string; play: boolean; releaseSource?: boolean }) => {
    const candidates = new Map(get(videoCandidatesAtom));
    const candidate = candidates.get(request.id);
    candidates.set(request.id, {
      ratio: candidate?.ratio ?? 1,
      pausedByUser: !request.play,
      autoplay: candidate?.autoplay ?? true,
    });
    set(videoCandidatesAtom, candidates);
    set(requestedVideoAtom, request.releaseSource ? null : request.id);
  },
);
