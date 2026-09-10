import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { ProfileEditDialog } from "@/components/profile-edit-dialog";
import { imageUploadingAtom } from "@/atoms/profile-edit";
import { authClient } from "@/lib/auth-client";
import { renderWithProviders } from "@/test/render";
import { m } from "@/paraglide/messages.js";

beforeEach(() => vi.clearAllMocks());

describe("ProfileEditDialog", () => {
  it("protects unsaved text, discards it explicitly, and reopens from the session", async () => {
    await renderWithProviders(<ProfileEditDialog />, {
      signedInAs: { name: "Existing Name", bio: "Existing bio" },
    });
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: m.profile_edit() });
    await user.click(trigger);
    const name = await screen.findByLabelText(m.auth_field_display_name());
    expect(name).toHaveValue("Existing Name");
    expect(screen.queryByLabelText(m.auth_field_username())).not.toBeInTheDocument();
    await user.clear(name);
    await user.type(name, "Unsaved name");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(m.profile_discard_prompt());
    await user.click(screen.getByRole("button", { name: m.profile_keep_editing() }));
    expect(name).toHaveValue("Unsaved name");
    await user.click(screen.getByRole("button", { name: m.common_close() }));
    await user.click(screen.getByRole("button", { name: m.profile_discard() }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(await screen.findByLabelText(m.auth_field_display_name())).toHaveValue("Existing Name");
  });

  it("keeps a failed save visible, blocks closing during upload, and closes after a successful save", async () => {
    const store = createStore();
    await renderWithProviders(<ProfileEditDialog />, { store, signedInAs: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.profile_edit() }));
    await screen.findByLabelText(m.auth_field_display_name());
    vi.mocked(authClient.updateUser).mockResolvedValueOnce({
      data: null,
      error: { message: "Save failed", status: 500, statusText: "Server Error" },
    });
    await user.click(screen.getByRole("button", { name: m.common_save() }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    act(() => store.set(imageUploadingAtom, "avatar"));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: m.common_save() })).toBeDisabled();
    act(() => store.set(imageUploadingAtom, null));
    await user.click(screen.getByRole("button", { name: m.common_save() }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
