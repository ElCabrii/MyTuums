import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { PostAttachmentGrid, type PostAttachmentView } from "@/components/post-attachment-grid";
import { m } from "@/paraglide/messages.js";

function makeAttachment(overrides: Partial<PostAttachmentView> = {}): PostAttachmentView {
  return {
    id: "attachment-1",
    url: "/media/posts/author/post/attachment-1.png",
    position: 0,
    contentType: "image/png",
    byteSize: 24,
    width: 1600,
    height: 900,
    ...overrides,
  };
}

describe("PostAttachmentGrid", () => {
  it("renders nothing for a post without attachments", async () => {
    const { container } = await renderWithProviders(<PostAttachmentGrid attachments={[]} />);

    // The harness renders a stub route beside the component (the <p> the
    // post-card tests also work around), so assert on the grid itself.
    expect(screen.queryByRole("region", { name: m.post_images_hint() })).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  // jsdom performs no layout, so the sizing behaviour can only be asserted
  // through the classes themselves — which is precisely where the fix for
  // issue #209 lives: singles must not carry `object-cover`, because under a
  // height cap that class is what centre-crops them on wide surfaces. They
  // must instead carry `object-contain`: with `w-full` making width definite
  // and `max-h-…` clamping height, the box becomes ratio-violating, so the
  // default `object-fit: fill` would stretch (squish) the image — `contain`
  // is what actually preserves the ratio and letterboxes into the cap.
  it("sizes a single image by its intrinsic aspect ratio under a proportional cap", async () => {
    await renderWithProviders(
      <PostAttachmentGrid attachments={[makeAttachment({ width: 1024, height: 1024 })]} />,
    );

    const image = screen.getByAltText(m.post_attachment_alt({ position: "1" }));
    expect(image).toHaveClass("h-auto");
    expect(image).toHaveClass("max-h-[32rem]");
    expect(image).toHaveClass("object-contain");
    expect(image).not.toHaveClass("object-cover");
  });

  it("keeps multi-image grid cells uniformly cover-cropped so mixed-ratio rows stay aligned", async () => {
    await renderWithProviders(
      <PostAttachmentGrid
        attachments={[
          makeAttachment({ id: "attachment-1", position: 0 }),
          makeAttachment({
            id: "attachment-2",
            position: 1,
            url: "/media/posts/author/post/attachment-2.webp",
            contentType: "image/webp",
            width: 900,
            height: 1600,
          }),
        ]}
      />,
    );

    const images = [
      screen.getByAltText(m.post_attachment_alt({ position: "1" })),
      screen.getByAltText(m.post_attachment_alt({ position: "2" })),
    ];
    for (const image of images) {
      expect(image).toHaveClass("object-cover");
      expect(image).toHaveClass("h-full");
      expect(image).toHaveClass("max-h-[32rem]");
    }
  });

  it.each([
    ["single", [makeAttachment()], "grid-cols-1"],
    ["multi", [makeAttachment(), makeAttachment({ id: "attachment-2" })], "grid-cols-2"],
  ])("lays a %s attachment set out on %s", async (_kind, attachments, columnClass) => {
    const { container } = await renderWithProviders(
      <PostAttachmentGrid attachments={attachments} />,
    );

    expect(container.firstElementChild).toHaveClass(columnClass);
  });

  it("carries each image's dimensions and announces its trigger as a viewer affordance", async () => {
    const first = makeAttachment();
    const second = makeAttachment({
      id: "attachment-2",
      position: 1,
      url: "/media/posts/author/post/attachment-2.webp",
      contentType: "image/webp",
    });
    await renderWithProviders(<PostAttachmentGrid attachments={[first, second]} />);

    const firstImage = screen.getByAltText(m.post_attachment_alt({ position: "1" }));
    const secondImage = screen.getByAltText(m.post_attachment_alt({ position: "2" }));
    expect(firstImage).toHaveAttribute("width", String(first.width));
    expect(firstImage).toHaveAttribute("height", String(first.height));
    expect(firstImage.closest("button")).toHaveAccessibleName(
      m.post_attachment_view({ position: "1" }),
    );
    expect(secondImage).toHaveAttribute("width", String(second.width));
    expect(secondImage).toHaveAttribute("height", String(second.height));
    expect(secondImage.closest("button")).toHaveAccessibleName(
      m.post_attachment_view({ position: "2" }),
    );
  });

  // Issue #203: the grid used to wrap every attachment in an <a
  // target="_blank">, navigating away from the conversation and exposing a
  // storage-oriented URL interaction. Now each cell is a viewer trigger, and
  // the selected image is what opens.
  it("opens the clicked attachment in the in-app viewer from a multi-image post", async () => {
    const first = makeAttachment();
    const second = makeAttachment({
      id: "attachment-2",
      position: 1,
      url: "/media/posts/author/post/attachment-2.webp",
      contentType: "image/webp",
      width: 900,
      height: 1600,
    });
    await renderWithProviders(<PostAttachmentGrid attachments={[first, second]} />);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: m.post_attachment_view({ position: "2" }) }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(m.post_attachment_alt({ position: "2" }));
    expect(
      within(dialog).getByRole("img", { name: m.post_attachment_alt({ position: "2" }) }),
    ).toHaveAttribute("src", second.url);
  });

  it("closes with Escape and returns focus to the attachment that opened it", async () => {
    await renderWithProviders(<PostAttachmentGrid attachments={[makeAttachment()]} />);
    const trigger = screen.getByRole("button", { name: m.post_attachment_view({ position: "1" }) });

    const user = userEvent.setup();
    await user.click(trigger);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("does not leak activation clicks into surrounding clickable surfaces", async () => {
    // PostCard navigates on any click its shell receives that did not land on
    // a control (see `handleCardClick`); the viewer must claim its own clicks
    // without letting them bubble there.
    const surfaceClick = vi.fn();
    await renderWithProviders(
      <div onClick={surfaceClick}>
        <PostAttachmentGrid attachments={[makeAttachment()]} />
      </div>,
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: m.post_attachment_view({ position: "1" }) }),
    );

    expect(surfaceClick).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("does not leak in-dialog clicks into surrounding clickable surfaces", async () => {
    // Opening the viewer only claims the trigger's own click. Once open, the
    // dialog is portaled to <body>, but React events still bubble through the
    // React tree — past this grid and into the post card's click-to-navigate
    // shell. Clicks on the full-size image, a loading/error state, or the
    // backdrop must be claimed too, or interacting with the viewer also
    // navigates to the thread.
    const surfaceClick = vi.fn();
    await renderWithProviders(
      <div onClick={surfaceClick}>
        <PostAttachmentGrid attachments={[makeAttachment()]} />
      </div>,
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: m.post_attachment_view({ position: "1" }) }),
    );
    const dialog = await screen.findByRole("dialog");

    // Clicking the full-size image must not bubble out of the viewer.
    fireEvent.click(
      within(dialog).getByRole("img", { name: m.post_attachment_alt({ position: "1" }) }),
    );
    expect(surfaceClick).not.toHaveBeenCalled();
  });

  it("replaces a broken full-size image with an alert instead of an empty modal", async () => {
    await renderWithProviders(<PostAttachmentGrid attachments={[makeAttachment()]} />);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: m.post_attachment_view({ position: "1" }) }),
    );
    const dialog = await screen.findByRole("dialog");

    fireEvent.error(
      within(dialog).getByRole("img", { name: m.post_attachment_alt({ position: "1" }) }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(m.image_viewer_error());
  });
});
