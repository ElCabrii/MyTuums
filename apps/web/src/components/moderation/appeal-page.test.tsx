import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ORPCError } from "@orpc/client";
import { renderWithProviders } from "@/test/render";
import { AppealPage } from "@/components/moderation/appeal-page";
import { m } from "@/paraglide/messages.js";

const { fakeClient } = vi.hoisted(() => ({
  fakeClient: { moderation: { appealOpen: vi.fn(), queue: vi.fn() } },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { orpc: createTanstackQueryUtils(fakeClient) };
});

beforeEach(() => {
  vi.clearAllMocks();
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
});
