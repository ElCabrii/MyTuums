import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import {
  activeVideoAtom,
  requestVideoPlaybackAtom,
  updateVideoVisibilityAtom,
  videoAutoplayAtom,
} from "./video-playback";

describe("video playback coordination (issue #368)", () => {
  it("selects one visible video and pauses when every player leaves view", () => {
    const store = createStore();
    store.set(updateVideoVisibilityAtom, { id: "first", ratio: 1 });
    store.set(updateVideoVisibilityAtom, { id: "second", ratio: 0.75 });
    expect(store.get(activeVideoAtom)).toBe("first");
    store.set(updateVideoVisibilityAtom, { id: "first", ratio: 0 });
    expect(store.get(activeVideoAtom)).toBe("second");
    store.set(updateVideoVisibilityAtom, { id: "second", remove: true });
    expect(store.get(activeVideoAtom)).toBeNull();
  });
  it("honors autoplay-off while allowing explicit playback, and preserves a user's pause", () => {
    const store = createStore();
    store.set(videoAutoplayAtom, false);
    store.set(updateVideoVisibilityAtom, { id: "first", ratio: 1 });
    expect(store.get(activeVideoAtom)).toBeNull();
    store.set(requestVideoPlaybackAtom, { id: "first", play: true });
    expect(store.get(activeVideoAtom)).toBe("first");
    store.set(requestVideoPlaybackAtom, { id: "first", play: false });
    store.set(videoAutoplayAtom, true);
    expect(store.get(activeVideoAtom)).toBeNull();
  });
  it("explicitly switching players transfers ownership and offscreen playback never continues", () => {
    const store = createStore();
    store.set(updateVideoVisibilityAtom, { id: "first", ratio: 1 });
    store.set(updateVideoVisibilityAtom, { id: "second", ratio: 0.5 });
    store.set(requestVideoPlaybackAtom, { id: "second", play: true });
    expect(store.get(activeVideoAtom)).toBe("second");
    store.set(updateVideoVisibilityAtom, { id: "second", ratio: 0 });
    expect(store.get(activeVideoAtom)).toBe("first");
  });
});
