import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { composerDraftAtom, composerPrivacyAtom } from "@/atoms/composer";
import { PostComposer } from "@/components/post-composer";
import { installTestOrpc } from "@/lib/orpc";
import { renderWithProviders } from "@/test/render";
import { m } from "@/paraglide/messages.js";

const fakeClient = {
  video: { pending: vi.fn().mockResolvedValue([]), cancel: vi.fn() },
  post: { create: vi.fn(), list: vi.fn() },
};
installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  fakeClient.post.create.mockReset();
});

describe("post visibility (issue #350)", () => {
  it("selects the audience by keyboard without submitting, and locks it while publishing", async () => {
    const user = userEvent.setup();
    const store = createStore();
    store.set(composerDraftAtom, "A draft");
    let rejectCreate!: (error: Error) => void;
    fakeClient.post.create.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );
    await renderWithProviders(<PostComposer />, { store, signedInAs: true });

    const trigger = screen.getByRole("button", {
      name: m.composer_visibility_trigger({ audience: m.composer_public_label() }),
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const publicOption = screen.getByRole("radio", { name: m.composer_public_label() });
    await waitFor(() => expect(publicOption).toHaveFocus());
    expect(publicOption).toBeChecked();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: m.composer_private_label() })).toBeChecked();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAccessibleName(
      m.composer_visibility_trigger({ audience: m.composer_private_label() }),
    );
    expect(fakeClient.post.create).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: m.post_action() }));
    await waitFor(() => expect(trigger).toBeDisabled());
    expect(fakeClient.post.create.mock.calls[0]?.[0]).toEqual({
      content: "A draft",
      attachments: [],
      isPrivate: true,
    });
    rejectCreate(new Error("Publication failed"));
    await screen.findByRole("alert");
    expect(trigger).not.toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveValue("A draft");
    expect(trigger).toHaveAccessibleName(
      m.composer_visibility_trigger({ audience: m.composer_private_label() }),
    );

    await user.click(trigger);
    await user.click(screen.getByRole("radio", { name: m.composer_public_label() }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: m.post_action() }));
    await waitFor(() => expect(fakeClient.post.create).toHaveBeenCalledTimes(2));
    expect(fakeClient.post.create.mock.calls[1]?.[0]).toEqual({
      content: "A draft",
      attachments: [],
      isPrivate: false,
    });
    rejectCreate(new Error("Publication failed"));
    await waitFor(() => expect(trigger).not.toBeDisabled());
  });

  it("explains the private-account restriction and overrides a stale public draft choice", async () => {
    const user = userEvent.setup();
    const store = createStore();
    store.set(composerDraftAtom, "Private account draft");
    store.set(composerPrivacyAtom, false);
    fakeClient.post.create.mockRejectedValue(new Error("Publication failed"));
    await renderWithProviders(<PostComposer />, { store, signedInAs: { isPrivate: true } });

    await user.click(
      screen.getByRole("button", {
        name: m.composer_visibility_trigger({ audience: m.composer_private_label() }),
      }),
    );
    expect(screen.getByText(m.composer_private_account_default())).toBeVisible();
    const publicOption = screen.getByRole("radio", { name: m.composer_public_label() });
    expect(publicOption).toHaveAttribute("aria-disabled", "true");
    await user.click(publicOption);
    expect(screen.getByRole("radio", { name: m.composer_private_label() })).toBeChecked();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: m.post_action() }));
    await screen.findByRole("alert");
    expect(fakeClient.post.create.mock.calls[0]?.[0]).toEqual({
      content: "Private account draft",
      attachments: [],
      isPrivate: true,
    });
  });
});
