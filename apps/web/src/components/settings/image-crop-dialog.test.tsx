import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
 * suite makes in `lib/media.test.ts`. What that leaves testable is the part
 * worth testing: the descriptor the dialog emits, which is what
 * `createDisplayVariant` bakes into the upload. The crop *arithmetic* itself is
 * pinned as pure functions in `lib/media.test.ts`; the pixel-accurate rendering
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

  it("names the slot it is editing", async () => {
    stubDecode(2000, 1200);
    await renderWithProviders(
      <ImageCropDialog kind="banner" file={file()} onApply={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(
      await screen.findByRole("heading", {
        name: m.settings_image_crop_title({ label: m.settings_banner_label() }),
      }),
    ).toBeInTheDocument();
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

  it("pans the crop center when the image is dragged", async () => {
    // A 800x1600 portrait in a square frame: the crop rect is 800x800, so
    // there is vertical room to pan and none horizontally.
    stubDecode(800, 1600);
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
    expect(frame).not.toBeNull();
    // Dragging the image DOWN by a quarter frame moves the visible region UP.
    await user.pointer([
      { target: frame!, coords: { clientX: 200, clientY: 200 }, keys: "[MouseLeft>]" },
      { target: frame!, coords: { clientX: 200, clientY: 300 } },
      { target: frame!, keys: "[/MouseLeft]" },
    ]);

    await user.click(screen.getByRole("button", { name: m.settings_image_crop_apply() }));

    const crop = onApply.mock.calls.at(-1)![0];
    // 100px of a 400px frame is a quarter of the 800px-tall crop rect = 200
    // source rows, which is 0.125 of the 1600px source.
    expect(crop.y).toBeCloseTo(0.375, 5);
    // Nothing to pan horizontally: the rect already spans the full width.
    expect(crop.x).toBe(0.5);
    expect(crop.scale).toBe(1);
  });

  it("zooms on wheel, and never below the cover rect", async () => {
    stubDecode(800, 800);
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

  it("reports an undecodable file rather than offering a crop of nothing", async () => {
    globalThis.createImageBitmap = vi.fn(() => Promise.reject(new Error("not an image")));
    await renderWithProviders(
      <ImageCropDialog kind="avatar" file={file()} onApply={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(await screen.findByText(m.validation_image_unreadable())).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.settings_image_crop_apply() })).toBeDisabled();
  });
});
