import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalVideoPreview } from "./local-video-preview";
import { m } from "@/paraglide/messages.js";

const urls = new Map<string, Blob | MediaSource>();

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:${crypto.randomUUID()}`;
    urls.set(url, blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    urls.delete(url);
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  urls.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("previews the selected local file and releases URLs on replacement and unmount", () => {
  const first = new File(["first"], "first.mp4", { type: "video/mp4" });
  const second = new File(["second"], "second.webm", { type: "video/webm" });
  const store = createStore();
  const { rerender, unmount } = render(
    <Provider store={store}>
      <LocalVideoPreview file={first} />
    </Provider>,
  );
  const video = screen.getByLabelText<HTMLVideoElement>(m.video_preview_label());
  expect(urls.get(video.src)).toBe(first);
  expect(video.controls).toBe(true);
  expect(video.autoplay).toBe(false);
  expect(video.preload).toBe("metadata");
  rerender(
    <Provider store={store}>
      <LocalVideoPreview file={second} />
    </Provider>,
  );
  expect(urls.get(video.src)).toBe(second);
  expect([...urls.values()]).toEqual([second]);
  unmount();
  expect(urls.size).toBe(0);
});

it("explains unsupported local playback without preventing the upload", () => {
  const file = new File(["unsupported"], "clip.mov", { type: "video/quicktime" });
  render(
    <Provider store={createStore()}>
      <LocalVideoPreview file={file} />
    </Provider>,
  );
  const video = screen.getByLabelText<HTMLVideoElement>(m.video_preview_label());
  fireEvent.error(video);
  expect(video).not.toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(m.video_preview_unavailable());
  expect(urls.get(video.src)).toBe(file);
});
