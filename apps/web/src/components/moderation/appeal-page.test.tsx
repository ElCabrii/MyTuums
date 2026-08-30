import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ORPCError } from "@orpc/client";

import { renderWithProviders } from "@/test/render";
import { appealReasonAtom } from "@/atoms/moderation";
import { AppealPage } from "@/components/moderation/appeal-page";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = {
  moderation: { appealOpen: vi.fn(), appealPreview: vi.fn(), queue: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
  // The default for every card-state test below: the preview resolves to
  // nothing, which is what a suspension or ban link returns and what a
  // signed-out visitor never asks for. The preview must not participate in
  // any of those states, so they assert against a page that has none.
  fakeClient.moderation.appealPreview.mockResolvedValue({ post: null });
});

describe("AppealPage — the four card states", () => {
  it("shows the missing-identifier card when the URL carries neither a token nor a postId", async () => {
    await renderWithProviders(<AppealPage />, { initialPath: "/appeal" });

    expect(
      await screen.findByRole("heading", { name: m.appeal_missing_title() }),
    ).toBeInTheDocument();
    // `Button` renders the link as `role="button"` (shadcn's `render` prop),
    // so this queries by role="button" rather than "link".
    expect(screen.getByRole("button", { name: m.common_back_to_home() })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.queryByLabelText(m.appeal_field_reason())).not.toBeInTheDocument();
  });

  it("shows the form when a postId is present, disabled below the minimum reason length", async () => {
    await renderWithProviders(<AppealPage />, {
      initialPath: "/appeal?postId=post-1",
      signedInAs: true,
    });

    expect(await screen.findByRole("heading", { name: m.appeal_title() })).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: m.appeal_submit() });
    expect(submit).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.appeal_field_reason()), "too short");
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(m.appeal_field_reason()), " — now over ten characters");
    expect(submit).toBeEnabled();
  });

  it("shows the success card once the appeal is submitted, keyed off the postId", async () => {
    fakeClient.moderation.appealOpen.mockResolvedValue({ appealId: "appeal-1", status: "open" });
    await renderWithProviders(<AppealPage />, {
      initialPath: "/appeal?postId=post-1",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.appeal_field_reason()), "It really wasn't spam");
    await user.click(screen.getByRole("button", { name: m.appeal_submit() }));

    expect(
      await screen.findByRole("heading", { name: m.appeal_success_title() }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(fakeClient.moderation.appealOpen).toHaveBeenCalledWith(
        { postId: "post-1", reason: "It really wasn't spam" },
        expect.anything(),
      ),
    );
  });

  it("shows the invalid-link title for a BAD_REQUEST error on a token link", async () => {
    fakeClient.moderation.appealOpen.mockRejectedValue(
      new ORPCError("BAD_REQUEST", { message: "This appeal link is invalid or has expired." }),
    );
    await renderWithProviders(<AppealPage />, { initialPath: "/appeal?token=bad-token" });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.appeal_field_reason()), "a".repeat(20));
    await user.click(screen.getByRole("button", { name: m.appeal_submit() }));

    expect(
      await screen.findByRole("heading", { name: m.appeal_invalid_title() }),
    ).toBeInTheDocument();
  });

  it("prompts a signed-out appellant to log in on an UNAUTHORIZED error, instead of a generic message", async () => {
    fakeClient.moderation.appealOpen.mockRejectedValue(new ORPCError("UNAUTHORIZED"));
    await renderWithProviders(<AppealPage />, {
      initialPath: "/appeal?postId=post-1",
      signedInAs: false,
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.appeal_field_reason()), "a".repeat(20));
    await user.click(screen.getByRole("button", { name: m.appeal_submit() }));

    expect(
      await screen.findByRole("heading", { name: m.appeal_error_title() }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: m.auth_log_in() })).toHaveAttribute("href", "/login");
  });

  it("shows the error's own message for an UNAUTHORIZED result while already signed in — not the sign-in prompt", async () => {
    fakeClient.moderation.appealOpen.mockRejectedValue(
      new ORPCError("UNAUTHORIZED", { message: "You can only appeal your own posts." }),
    );
    await renderWithProviders(<AppealPage />, {
      initialPath: "/appeal?postId=post-1",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.appeal_field_reason()), "a".repeat(20));
    await user.click(screen.getByRole("button", { name: m.appeal_submit() }));

    expect(
      await screen.findByRole("heading", { name: m.appeal_error_title() }),
    ).toBeInTheDocument();
    expect(screen.getByText("You can only appeal your own posts.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: m.auth_log_in() })).not.toBeInTheDocument();
  });

  it("clears the reason draft on a successful submission, through the active Provider store", async () => {
    fakeClient.moderation.appealOpen.mockResolvedValue({ appealId: "appeal-1", status: "open" });
    const { store } = await renderWithProviders(<AppealPage />, {
      initialPath: "/appeal?postId=post-1",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.appeal_field_reason()), "It really wasn't spam");
    await waitFor(() => expect(store.get(appealReasonAtom)).toBe("It really wasn't spam"));

    await user.click(screen.getByRole("button", { name: m.appeal_submit() }));
    await screen.findByRole("heading", { name: m.appeal_success_title() });

    // The reset lands in the same Provider store that mounted the page (a
    // module-scope write would miss it and this assertion would hang on the
    // stale draft).
    await waitFor(() => expect(store.get(appealReasonAtom)).toBe(""));
  });

  /**
   * `AppealPage`'s only real logic is `key={identifier}` (appeal-page.tsx),
   * documented as making a submitted state from one link not greet the next
   * link's form. Every other test here renders at a fixed `initialPath`, so
   * this is the one place that actually navigates between two identifiers —
   * dropping the `key` would leave this on the success card.
   */
  it("remounts fresh when the identifier changes, dropping a prior submission's success state", async () => {
    fakeClient.moderation.appealOpen.mockResolvedValue({ appealId: "appeal-1", status: "open" });
    const { router, store } = await renderWithProviders(<AppealPage />, {
      initialPath: "/appeal?postId=post-1",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.appeal_field_reason()), "It really wasn't spam");
    await user.click(screen.getByRole("button", { name: m.appeal_submit() }));
    expect(
      await screen.findByRole("heading", { name: m.appeal_success_title() }),
    ).toBeInTheDocument();

    await act(async () => {
      await router.navigate({ to: "/appeal", search: { postId: "post-2" } });
    });

    // The remount is what's under test here — the card state is what
    // `key={identifier}` actually owns, and it's what a real link swap depends
    // on (the mutation observer's own `isSuccess`, which unmount/remount does
    // reset). The reason draft was cleared by the first submission's success
    // (see the dedicated draft-reset test), so the fresh form starts blank.
    expect(await screen.findByRole("heading", { name: m.appeal_title() })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: m.appeal_success_title() }),
    ).not.toBeInTheDocument();
    expect(store.get(appealReasonAtom)).toBe("");
  });
});

/**
 * The preview is context for the form, never a precondition for it — so what
 * these pin is as much what it does NOT do (ask anything while signed out,
 * stand between a banned appellant and the form) as what it renders.
 */
describe("AppealPage — the removed post preview", () => {
  const attachment = {
    id: "att-1",
    url: "/media/posts/author-1/post-1/att-1.png",
    position: 0,
    contentType: "image/png",
    byteSize: 24,
    width: 64,
    height: 64,
  };

  it("shows the removed post's text, images and reason above the form", async () => {
    fakeClient.moderation.appealPreview.mockResolvedValue({
      post: {
        id: "post-1",
        content: "the removed words",
        createdAt: new Date().toISOString(),
        removedReason: "spam",
        attachments: [attachment],
      },
    });
    await renderWithProviders(<AppealPage />, {
      initialPath: "/appeal?postId=post-1",
      signedInAs: true,
    });

    expect(await screen.findByText("the removed words")).toBeInTheDocument();
    expect(screen.getByAltText(m.post_attachment_alt({ position: "1" }))).toHaveAttribute(
      "src",
      attachment.url,
    );
    expect(screen.getByText(m.appeal_preview_reason({ reason: "spam" }))).toBeInTheDocument();
    // The form is still the point of the page.
    expect(screen.getByLabelText(m.appeal_field_reason())).toBeInTheDocument();
  });

  it("names an image-only post as having no text instead of rendering an empty line", async () => {
    fakeClient.moderation.appealPreview.mockResolvedValue({
      post: {
        id: "post-1",
        content: "",
        createdAt: new Date().toISOString(),
        removedReason: "spam",
        attachments: [attachment],
      },
    });
    await renderWithProviders(<AppealPage />, {
      initialPath: "/appeal?postId=post-1",
      signedInAs: true,
    });

    expect(await screen.findByText(m.appeal_preview_no_text())).toBeInTheDocument();
    expect(screen.getByAltText(m.post_attachment_alt({ position: "1" }))).toBeInTheDocument();
  });

  it("asks for nothing while signed out, and leaves the form working", async () => {
    await renderWithProviders(<AppealPage />, { initialPath: "/appeal?token=some-token" });

    expect(await screen.findByRole("heading", { name: m.appeal_title() })).toBeInTheDocument();
    expect(screen.getByLabelText(m.appeal_field_reason())).toBeInTheDocument();
    expect(screen.queryByText(m.appeal_preview_title())).not.toBeInTheDocument();
    // The procedure is session-gated: a signed-out visitor holding a
    // suspension or ban link would only ever get UNAUTHORIZED back.
    expect(fakeClient.moderation.appealPreview).not.toHaveBeenCalled();
  });

  it("renders no preview for an action with no post behind it", async () => {
    fakeClient.moderation.appealPreview.mockResolvedValue({ post: null });
    await renderWithProviders(<AppealPage />, {
      initialPath: "/appeal?token=some-token",
      signedInAs: true,
    });

    expect(await screen.findByRole("heading", { name: m.appeal_title() })).toBeInTheDocument();
    expect(screen.queryByText(m.appeal_preview_title())).not.toBeInTheDocument();
  });
});
