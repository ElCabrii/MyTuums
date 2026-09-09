import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoPlayer } from "./video-player";
import { videoCandidatesAtom, updateVideoVisibilityAtom } from "@/atoms/video-playback";

const attachment: ComponentProps<typeof VideoPlayer>["attachment"] = {
  id: "clip",
  position: 0,
  contentType: "application/vnd.apple.mpegurl",
  byteSize: 100,
  url: "/clip/master.m3u8",
  width: 640,
  height: 360,
  video: {
    duration: 20,
    frameRate: 30,
    previewUrl: "",
    captionUrl: null,
    captionLanguage: null,
    posterUrl: "/clip/poster.jpg",
    renditions: [],
  },
};

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
  // Model native media state; load() resets the element and cancels queued media
  // events. This is the pause-button regression reproduced in real Chromium.
  let generation = 0;
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    generation++;
    this.currentTime = 0;
    Object.defineProperty(this, "readyState", { configurable: true, value: 0 });
    fireEvent.emptied(this);
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    fireEvent.play(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    const pending = generation;
    queueMicrotask(() => {
      if (pending === generation) fireEvent.pause(this);
    });
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "fullscreenElement");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps play/pause usable after the first pause without resetting a visible stream", async () => {
  const store = createStore();
  const { container } = render(
    <Provider store={store}>
      <VideoPlayer attachment={attachment} />
    </Provider>,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video");
  fireEvent.click(screen.getByRole("button", { name: "Play video" }));
  await waitFor(() => expect(video.getAttribute("src")).toBe("/clip/master.m3u8"));
  fireEvent.click(screen.getByRole("button", { name: "Pause video" }));
  Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
  await act(() => fireEvent.loadedMetadata(video));
  expect(video.paused).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Play video" }));
  await screen.findByRole("button", { name: "Pause video" });
  video.currentTime = 3;
  fireEvent.timeUpdate(video);
  for (let cycle = 0; cycle < 3; cycle++) {
    fireEvent.click(screen.getByRole("button", { name: "Pause video" }));
    await screen.findByRole("button", { name: "Play video" });
    expect(video.paused).toBe(true);
    expect(video.getAttribute("src")).toBe("/clip/master.m3u8");
    expect(video.currentTime).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));
    await screen.findByRole("button", { name: "Pause video" });
    expect(video.paused).toBe(false);
  }
  const id = [...store.get(videoCandidatesAtom).keys()][0];
  if (!id) throw new Error("Missing player registration");
  act(() => store.set(updateVideoVisibilityAtom, { id, ratio: 0 }));
  expect(video.getAttribute("src")).toBeNull();
});

it("keeps quality and speed options within the fullscreen player", async () => {
  const user = userEvent.setup();
  render(
    <Provider store={createStore()}>
      <VideoPlayer attachment={attachment} />
    </Provider>,
  );
  const player = screen.getByRole("group", { name: "Post video" });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: player });
  fireEvent(document, new Event("fullscreenchange"));
  for (const label of ["Video quality", "Playback speed"]) {
    await user.click(screen.getByRole("combobox", { name: label }));
    expect(player).toContainElement(screen.getByRole("listbox"));
    await user.keyboard("{Escape}");
  }
});

it("toggles playback by clicking the video and pressing Space without repeating or bubbling", async () => {
  const user = userEvent.setup();
  const outerClick = vi.fn();
  const { container } = render(
    <div onClick={outerClick}>
      <Provider store={createStore()}>
        <VideoPlayer attachment={attachment} />
      </Provider>
    </div>,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video");
  await user.click(video);
  expect(screen.getByRole("button", { name: "Pause video" })).toBeVisible();
  expect(video).toHaveFocus();
  await user.keyboard(" ");
  expect(screen.getByRole("button", { name: "Play video" })).toBeVisible();
  fireEvent.keyDown(video, { key: " ", repeat: true });
  expect(screen.getByRole("button", { name: "Play video" })).toBeVisible();
  await user.keyboard(" ");
  expect(screen.getByRole("button", { name: "Pause video" })).toBeVisible();
  await user.click(video);
  expect(screen.getByRole("button", { name: "Play video" })).toBeVisible();
  expect(outerClick).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Play video" }));
  await user.keyboard(" ");
  expect(screen.getByRole("button", { name: "Play video" })).toBeVisible();
  await user.click(screen.getByRole("combobox", { name: "Playback speed" }));
  await user.keyboard(" ");
  expect(screen.getByRole("button", { name: "Play video" })).toBeVisible();
});
