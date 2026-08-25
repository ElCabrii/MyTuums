import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
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

  it("carries each image's dimensions and links it to its own media URL", async () => {
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
    expect(firstImage.closest("a")).toHaveAttribute("href", first.url);
    expect(secondImage).toHaveAttribute("width", String(second.width));
    expect(secondImage).toHaveAttribute("height", String(second.height));
    expect(secondImage.closest("a")).toHaveAttribute("href", second.url);
  });

  it("renders compact thumbnails without link wrappers, so the grid can live inside a button", async () => {
    const { container } = await renderWithProviders(
      <PostAttachmentGrid
        attachments={[makeAttachment(), makeAttachment({ id: "attachment-2", position: 1 })]}
        compact
      />,
    );

    // A flex row of thumbnails, not the feed's link-wrapped grid.
    expect(container.firstElementChild).toHaveClass("flex");
    expect(container.firstElementChild).not.toHaveClass("grid");
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    for (const image of images) {
      // Small cover-cropped squares, and bare <img>s — no <a> opens the image,
      // so a click bubbles to the row button that mounts this grid (the
      // moderation queue row), which is the point: the row opens the case.
      expect(image).toHaveClass("size-14");
      expect(image).toHaveClass("object-cover");
      expect(image.closest("a")).toBeNull();
    }
  });
});
