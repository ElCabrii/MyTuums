import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { ImageViewer } from "@/components/image-viewer";
import { m } from "@/paraglide/messages.js";

/** A minimal viewer whose thumbnail is a bare img, the way call sites embed one. */
function renderViewer(props: Partial<Parameters<typeof ImageViewer>[0]> = {}) {
  return renderWithProviders(
    <ImageViewer
      src="/media/full.png"
      alt="Full picture"
      title="A full picture"
      triggerLabel="Open the picture"
      {...props}
    >
      <img src="/media/thumb.png" alt="" />
    </ImageViewer>,
  );
}

describe("ImageViewer", () => {
  it("opens from its trigger and closes from the dialog's own close control, returning focus", async () => {
    await renderViewer();

    const trigger = screen.getByRole("button", { name: "Open the picture" });
    const user = userEvent.setup();
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img", { name: "Full picture" })).toHaveAttribute(
      "src",
      "/media/full.png",
    );

    await user.click(within(dialog).getByRole("button", { name: m.common_close() }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("announces loading until the full-size image reports itself loaded", async () => {
    await renderViewer();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open the picture" }));

    // jsdom performs no image loading, so nothing fires until the test does —
    // which is exactly what makes the pre-load state observable.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(m.image_viewer_loading())).toBeInTheDocument();

    fireEvent.load(within(dialog).getByRole("img", { name: "Full picture" }));

    expect(within(dialog).queryByText(m.image_viewer_loading())).toBeNull();
  });

  it("replaces a broken full-size image with an alert and stays closable", async () => {
    await renderViewer();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open the picture" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.error(within(dialog).getByRole("img", { name: "Full picture" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(m.image_viewer_error());

    await user.click(within(dialog).getByRole("button", { name: m.common_close() }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each([
    ["explicit", "Opened at full size" as const],
    ["fallback", undefined],
  ])("takes its accessible description from %s copy", async (_kind, description) => {
    await renderViewer({ description });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open the picture" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription(description ?? "A full picture");
  });
});
