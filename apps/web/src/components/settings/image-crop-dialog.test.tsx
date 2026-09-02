import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import type { Crop } from "@/lib/media";
import { ImageCropDialog } from "@/components/settings/image-crop-dialog";
import { m } from "@/paraglide/messages.js";

/**
 * The editor's caller-visible behaviour: what crop it hands back, and when.
 *
 * jsdom implements neither `createImageBitmap` nor object URLs nor pointer
 * capture, so all three are stubbed here — the same trade the encoder's own
 * suite makes in `lib/media.dom.test.ts`. What that leaves testable is the part
 * worth testing: the descriptor the dialog emits, which is what
 * `createDisplayVariant` bakes into the upload. The crop *arithmetic* itself is
 * pinned as pure functions in `lib/media.dom.test.ts`; the pixel-accurate rendering
 * is a browser concern covered by `e2e/tests/specs/settings.spec.ts`.
 */

const originalCreateImageBitmap = globalThis.createImageBitmap;
// Bound rather than captured bare: these are methods on `URL`, and handing
// an unbound reference around is what `@typescript-eslint/unbound-method`
// exists to catch.
const originalCreateObjectURL = globalThis.URL.createObjectURL.bind(globalThis.URL);
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL.bind(globalThis.URL);

/** Stands in for a decoded bitmap of `width`x`height`. */
function stubDecode(width: number, height: number) {
  const close = vi.fn();
  globalThis.createImageBitmap = vi.fn().mockResolvedValue({ width, height, close });
  return close;
}

/**
 * jsdom lays nothing out, so `getBoundingClientRect` is all zeroes and the
 * drag handler would refuse every press. A fixed frame size makes the
 * pointer-delta arithmetic deterministic.
 */
function stubFrameSize(width: number, height: number) {
  vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

/** Gives pointer-move tests deterministic control over frame-rate coalescing. */
function stubAnimationFrame() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    nextId += 1;
    callbacks.set(nextId, callback);
    return nextId;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  return {
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(performance.now());
    },
  };
}

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => "blob:crop");
  globalThis.URL.revokeObjectURL = vi.fn();
  // jsdom has no pointer capture; the component calls it on every press.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  globalThis.createImageBitmap = originalCreateImageBitmap;
  globalThis.URL.createObjectURL = originalCreateObjectURL;
  globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

const file = () => new File(["pic"], "pic.png", { type: "image/png" });

describe("ImageCropDialog", () => {
  it("applies a centered, unzoomed crop by default", async () => {
    stubDecode(800, 800);
    const onApply = vi.fn<(crop: Crop) => void>();
    await renderWithProviders(
      <ImageCropDialog kind="avatar" file={file()} onApply={onApply} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();

    // The Apply button unlocks only once the source has been decoded — until
    // then there are no dimensions to crop against.
    const apply = await screen.findByRole("button", { name: m.settings_image_crop_apply() });
    await waitFor(() => expect(apply).toBeEnabled());
    await user.click(apply);

    expect(onApply).toHaveBeenCalledWith({ x: 0.5, y: 0.5, scale: 1 });
  });

  it("previews a portrait avatar in the square frame used by avatar surfaces", async () => {
    stubDecode(400, 800);
    const { container } = await renderWithProviders(
      <ImageCropDialog kind="avatar" file={file()} onApply={vi.fn()} onCancel={vi.fn()} />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: m.settings_image_crop_apply() })).toBeEnabled(),
    );
    expect(container.ownerDocument.querySelector<HTMLElement>(".touch-none")).toHaveStyle({
      aspectRatio: "1",
    });
    const visibleArea = container.ownerDocument.querySelector<HTMLElement>(
      '[aria-hidden="true"].rounded-full',
    );
    expect(visibleArea).toHaveStyle({ width: "100%", height: "100%" });
    expect(screen.getByRole("dialog")).toHaveClass(
      "max-h-[calc(100dvh-2rem)]",
      "overflow-y-auto",
      "[&>*]:shrink-0",
    );
  });

  it("shows the whole banner source and outlines the actual crop selection", async () => {
    stubDecode(2000, 1200);
    const { container } = await renderWithProviders(
      <ImageCropDialog kind="banner" file={file()} onApply={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(
      await screen.findByRole("heading", {
        name: m.settings_image_crop_title({ label: m.settings_banner_label() }),
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(m.settings_image_crop_hint())).toBeInTheDocument();
    await waitFor(() =>
      expect(container.ownerDocument.querySelector(".touch-none img")).toBeInTheDocument(),
    );
    const preview = container.ownerDocument.querySelector<HTMLElement>(".touch-none");
    expect(preview).toHaveStyle({ aspectRatio: `${2000 / 1200}` });
    expect(preview?.querySelector("img")).toHaveStyle({
      width: "100%",
      height: "100%",
      left: "0%",
      top: "0%",
    });

    // At the zoom-out floor, the actual 3:1 crop spans the source width and
    // leaves only vertical slack. The outline is that crop, not a separate
    // fixed safe-area guide that happens to look selectable.
    const outline = container.ownerDocument.querySelector<HTMLElement>(
      ".touch-none [aria-hidden='true']",
    );
    expect(outline).toHaveStyle({
      width: "100%",
      height: `${(667 / 1200) * 100}%`,
      left: "0%",
      top: `${(266 / 1200) * 100}%`,
    });
    expect(screen.getByRole("dialog")).toHaveClass(
      "max-h-[calc(100dvh-2rem)]",
      "overflow-y-auto",
      "[&>*]:shrink-0",
    );
  });

  it("cancels without applying a crop", async () => {
    stubDecode(800, 800);
    const onApply = vi.fn<(crop: Crop) => void>();
    const onCancel = vi.fn();
    await renderWithProviders(
      <ImageCropDialog kind="avatar" file={file()} onApply={onApply} onCancel={onCancel} />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: m.common_cancel() }));

    expect(onCancel).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("keeps the banner crop frame fixed while the image moves beneath it", async () => {
    stubDecode(1000, 1000);
    stubFrameSize(1000, 1000);
    const onApply = vi.fn<(crop: Crop) => void>();
    const { container } = await renderWithProviders(
      <ImageCropDialog kind="banner" file={file()} onApply={onApply} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: m.settings_image_crop_apply() })).toBeEnabled(),
    );

    const frame = container.ownerDocument.querySelector<HTMLElement>(".touch-none");
    expect(frame).not.toBeNull();
    fireEvent.wheel(frame!, { deltaY: -100 });
    await user.pointer([
      { target: frame!, coords: { clientX: 500, clientY: 500 }, keys: "[MouseLeft>]" },
      { target: frame!, coords: { clientX: 525, clientY: 525 } },
      { target: frame!, keys: "[/MouseLeft]" },
    ]);

    await user.click(screen.getByRole("button", { name: m.settings_image_crop_apply() }));

    const crop = onApply.mock.calls.at(-1)![0];
    expect(crop.x).toBeCloseTo(0.4773, 4);
    expect(crop.y).toBeCloseTo(0.4773, 4);
    expect(crop.scale).toBeCloseTo(1.1, 5);
    expect(frame?.querySelector("[aria-hidden='true']")).toHaveStyle({
      width: "100%",
      height: `${(333 / 1000) * 100}%`,
      left: "0%",
      top: `${(333 / 1000) * 100}%`,
    });
    expect(frame?.querySelector("img")).not.toHaveStyle({ transform: "none" });
  });

  it.each(["avatar", "banner"] as const)(
    "coalesces %s pointer moves to one update per animation frame",
    async (kind) => {
      const animationFrame = stubAnimationFrame();
      stubDecode(1000, 1000);
      stubFrameSize(1000, 1000);
      const { container } = await renderWithProviders(
        <ImageCropDialog kind={kind} file={file()} onApply={vi.fn()} onCancel={vi.fn()} />,
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: m.settings_image_crop_apply() })).toBeEnabled(),
      );
      const frame = container.ownerDocument.querySelector<HTMLElement>(".touch-none")!;
      fireEvent.wheel(frame, { deltaY: -100 });
      const image = frame.querySelector<HTMLElement>("img")!;
      const outline = frame.querySelector<HTMLElement>("[aria-hidden='true']")!;
      const imageStyleBeforeDrag = image.style.cssText;
      const outlineStyleBeforeDrag = outline.style.cssText;

      fireEvent.pointerDown(frame, { pointerId: 1, clientX: 500, clientY: 500 });
      fireEvent.pointerMove(frame, { pointerId: 1, clientX: 510, clientY: 510 });
      fireEvent.pointerMove(frame, { pointerId: 1, clientX: 520, clientY: 520 });

      expect(image.style.cssText).toBe(imageStyleBeforeDrag);
      expect(outline.style.cssText).toBe(outlineStyleBeforeDrag);
      act(() => animationFrame.flush());
      expect(image.style.cssText).not.toBe(imageStyleBeforeDrag);
    },
  );

  it("moves immediately when an avatar drag reverses away from a clamped edge", async () => {
    const animationFrame = stubAnimationFrame();
    stubDecode(400, 800);
    stubFrameSize(400, 400);
    const onApply = vi.fn<(crop: Crop) => void>();
    const { container } = await renderWithProviders(
      <ImageCropDialog kind="avatar" file={file()} onApply={onApply} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: m.settings_image_crop_apply() })).toBeEnabled(),
    );
    const frame = container.ownerDocument.querySelector<HTMLElement>(".touch-none")!;

    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 200, clientY: 600 });
    act(() => animationFrame.flush());
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 200, clientY: 590 });
    act(() => animationFrame.flush());
    fireEvent.pointerUp(frame, { pointerId: 1, clientX: 200, clientY: 590 });
    await user.click(screen.getByRole("button", { name: m.settings_image_crop_apply() }));

    expect(onApply.mock.calls.at(-1)?.[0].y).toBeCloseTo(0.2625, 5);
  });

  it("pans a portrait avatar within its square composition", async () => {
    stubDecode(400, 800);
    stubFrameSize(400, 400);
    const onApply = vi.fn<(crop: Crop) => void>();
    const { container } = await renderWithProviders(
      <ImageCropDialog kind="avatar" file={file()} onApply={onApply} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: m.settings_image_crop_apply() })).toBeEnabled(),
    );

    const frame = container.ownerDocument.querySelector<HTMLElement>(".touch-none");
    await user.pointer([
      { target: frame!, coords: { clientX: 200, clientY: 150 }, keys: "[MouseLeft>]" },
      { target: frame!, coords: { clientX: 200, clientY: 250 } },
      { target: frame!, keys: "[/MouseLeft]" },
    ]);
    await user.click(screen.getByRole("button", { name: m.settings_image_crop_apply() }));

    expect(onApply).toHaveBeenLastCalledWith({ x: 0.5, y: 0.375, scale: 1 });
  });

  it("zooms on wheel, and never below the cover rect", async () => {
    stubDecode(400, 800);
    stubFrameSize(400, 400);
    const onApply = vi.fn<(crop: Crop) => void>();
    const { container } = await renderWithProviders(
      <ImageCropDialog kind="avatar" file={file()} onApply={onApply} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: m.settings_image_crop_apply() })).toBeEnabled(),
    );
    const frame = container.ownerDocument.querySelector(".touch-none");

    fireEvent.wheel(frame!, { deltaY: -100 });
    await user.click(screen.getByRole("button", { name: m.settings_image_crop_apply() }));
    expect(onApply.mock.calls.at(-1)?.[0].scale).toBeCloseTo(1.1, 5);

    // Scrolling back out stops at 1: the cover rect is the widest crop there
    // is, and going below it would ask the encoder to draw outside the source.
    fireEvent.wheel(frame!, { deltaY: 100 });
    fireEvent.wheel(frame!, { deltaY: 100 });
    fireEvent.wheel(frame!, { deltaY: 100 });
    await user.click(screen.getByRole("button", { name: m.settings_image_crop_apply() }));
    expect(onApply.mock.calls.at(-1)?.[0].scale).toBe(1);
  });

  it("keeps a mid-drag wheel zoom: the next move pans at the zoom on screen", async () => {
    // Regression: `dragRef` captured the descriptor at pointer-down, so a wheel
    // zoom during the drag updated the preview but not the capture — and the
    // next pointer-move recomputed the crop from the pre-zoom scale, snapping
    // the zoom back. The drag anchor must follow what the person is seeing.
    stubDecode(400, 800);
    stubFrameSize(400, 400);
    const onApply = vi.fn<(crop: Crop) => void>();
    const { container } = await renderWithProviders(
      <ImageCropDialog kind="avatar" file={file()} onApply={onApply} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: m.settings_image_crop_apply() })).toBeEnabled(),
    );
    const frame = container.ownerDocument.querySelector<HTMLElement>(".touch-none");

    // Drag the image down 100px at scale 1, then zoom in one notch over the
    // same spot, then drag 100px further.
    await user.pointer([
      { target: frame!, coords: { clientX: 200, clientY: 100 }, keys: "[MouseLeft>]" },
      { target: frame!, coords: { clientX: 200, clientY: 200 } },
    ]);
    fireEvent.wheel(frame!, { deltaY: -100, clientX: 200, clientY: 200 });
    await user.pointer([
      { target: frame!, coords: { clientX: 200, clientY: 300 } },
      { target: frame!, keys: "[/MouseLeft]" },
    ]);
    await user.click(screen.getByRole("button", { name: m.settings_image_crop_apply() }));

    const crop = onApply.mock.calls.at(-1)![0];
    // The zoom survives the move that follows it.
    expect(crop.scale).toBeCloseTo(1.1, 5);
    // The first 100px pans against the 400px rect: 100/400 · 400/800 moves the
    // center from 0.5 to 0.375. The zoom rebases the anchor (the wheel fires
    // over the pointer's position), so the next 100px pans against the zoomed
    // 364px rect instead of counting the first stretch twice.
    expect(crop.y).toBeCloseTo(0.375 - (100 / 400) * (364 / 800), 5);
    expect(crop.x).toBe(0.5);
  });

  it("refuses to zoom a banner out past its default window", async () => {
    // A 3:2 photo's default window already spans the photo's full width — the
    // largest 3:1 rectangle there is (issue #273). Scrolling out must stop
    // there: the emitted crop stays at scale 1 and the preview keeps the image
    // filling the frame, never shrinking it into letterbox bars.
    stubDecode(1500, 1000);
    stubFrameSize(1500, 500);
    const onApply = vi.fn<(crop: Crop) => void>();
    const { container } = await renderWithProviders(
      <ImageCropDialog kind="banner" file={file()} onApply={onApply} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: m.settings_image_crop_apply() })).toBeEnabled(),
    );
    const frame = container.ownerDocument.querySelector(".touch-none");

    fireEvent.wheel(frame!, { deltaY: 100 });
    fireEvent.wheel(frame!, { deltaY: 100 });
    await user.click(screen.getByRole("button", { name: m.settings_image_crop_apply() }));

    expect(onApply.mock.calls.at(-1)![0]).toEqual({ x: 0.5, y: 0.5, scale: 1 });
    // The whole source remains visible behind the full-width crop outline.
    expect(container.ownerDocument.querySelector(".touch-none img")).toHaveStyle({
      width: "100%",
      height: "100%",
      left: "0%",
      top: "0%",
    });
    expect(container.ownerDocument.querySelector(".touch-none [aria-hidden='true']")).toHaveStyle({
      width: "100%",
      height: "50%",
      left: "0%",
      top: "25%",
    });
  });

  it("reports an undecodable file rather than offering a crop of nothing", async () => {
    globalThis.createImageBitmap = vi.fn(() => Promise.reject(new Error("not an image")));
    await renderWithProviders(
      <ImageCropDialog kind="avatar" file={file()} onApply={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(await screen.findByText(m.validation_image_unreadable())).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.settings_image_crop_apply() })).toBeDisabled();
  });
});
