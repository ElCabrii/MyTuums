import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { BIO_MAX_LENGTH } from "@my-tuums/auth/rules";
import { authErrorAtom } from "@/atoms/auth";
import { authClient } from "@/lib/auth-client";
import { createDisplayVariant } from "@/lib/media";
import { ProfileSection } from "@/components/settings/profile-section";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestClient, installTestOrpc } from "@/lib/orpc";
import { installTestDisplayVariant } from "@/lib/media";

const fakeClient = {
  user: {
    uploadImage: vi.fn(() => Promise.resolve()),
    removeImage: vi.fn(() => Promise.resolve()),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));
installTestClient(fakeClient);
installTestDisplayVariant(vi.fn((file: File) => Promise.resolve(file)));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProfileSection", () => {
  it("hydrates from the session and saves trimmed name and bio", async () => {
    await renderWithProviders(<ProfileSection />, {
      signedInAs: { name: "Existing Name", bio: "Existing bio" },
    });
    const user = userEvent.setup();
    const name = screen.getByLabelText(m.auth_field_display_name());
    const bio = screen.getByLabelText(m.auth_field_bio());

    expect(name).toHaveValue("Existing Name");
    expect(bio).toHaveValue("Existing bio");
    await user.clear(name);
    await user.type(name, "  Updated Name  ");
    await user.clear(bio);
    await user.type(bio, "  Updated bio  ");
    await user.click(screen.getByRole("button", { name: m.common_save() }));

    await waitFor(() =>
      expect(authClient.updateUser).toHaveBeenCalledWith({
        name: "Updated Name",
        bio: "Updated bio",
      }),
    );
  });

  // Typed rather than pasted on purpose — the counter is a derived atom, so
  // what is being asserted is that it tracks every keystroke, not just the
  // final value. That means BIO_MAX_LENGTH + 1 real key events and a re-render
  // apiece, which lands just over vitest's 5s default on a loaded machine. The
  // budget is raised rather than the input shortened, because a shorter one
  // would stop crossing the limit and stop testing the thing.
  it("shows the live counter and rejects an over-limit bio before transport", async () => {
    const store = createStore();
    await renderWithProviders(<ProfileSection />, { store, signedInAs: true });
    const user = userEvent.setup();
    const overLimit = "x".repeat(BIO_MAX_LENGTH + 1);
    const bio = screen.getByLabelText(m.auth_field_bio());
    await user.type(bio, overLimit);

    expect(screen.getByText("-1")).toHaveClass("text-destructive");
    await user.click(screen.getByRole("button", { name: m.common_save() }));
    expect(authClient.updateUser).not.toHaveBeenCalled();
    expect(store.get(authErrorAtom)).toMatch(/bio/i);
  }, 20_000);

  it("uploads and removes both avatar and banner through the transport boundary", async () => {
    const display = new File(["display"], "display.webp", { type: "image/webp" });
    vi.mocked(createDisplayVariant).mockResolvedValue(display);
    await renderWithProviders(<ProfileSection />, {
      signedInAs: { image: "/avatar.webp", bannerImage: "/banner.webp" },
    });
    const user = userEvent.setup();
    const avatar = new File(["avatar"], "avatar.png", { type: "image/png" });
    const banner = new File(["banner"], "banner.jpg", { type: "image/jpeg" });

    await user.upload(screen.getByLabelText(m.settings_avatar_label()), avatar);
    await waitFor(() =>
      expect(fakeClient.user.uploadImage).toHaveBeenCalledWith({
        kind: "avatar",
        original: avatar,
        display,
      }),
    );
    await user.upload(screen.getByLabelText(m.settings_banner_label()), banner);
    await waitFor(() =>
      expect(fakeClient.user.uploadImage).toHaveBeenCalledWith({
        kind: "banner",
        original: banner,
        display,
      }),
    );

    await user.click(
      screen.getByRole("button", {
        name: m.settings_image_remove_label({ label: m.settings_avatar_label() }),
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: m.settings_image_remove_label({ label: m.settings_banner_label() }),
      }),
    );
    await waitFor(() => {
      expect(fakeClient.user.removeImage).toHaveBeenCalledWith({ kind: "avatar" });
      expect(fakeClient.user.removeImage).toHaveBeenCalledWith({ kind: "banner" });
    });
  });

  it("locks both image slots while either upload is in flight", async () => {
    let release!: (file: File) => void;
    vi.mocked(createDisplayVariant).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await renderWithProviders(<ProfileSection />, { signedInAs: true });
    const user = userEvent.setup();
    const avatar = new File(["avatar"], "avatar.png", { type: "image/png" });

    await user.upload(screen.getByLabelText(m.settings_avatar_label()), avatar);
    await waitFor(() => {
      for (const button of screen.getAllByRole("button", { name: m.settings_image_choose() })) {
        expect(button).toBeDisabled();
      }
    });

    act(() => release(avatar));
    await waitFor(() => {
      for (const button of screen.getAllByRole("button", { name: m.settings_image_choose() })) {
        expect(button).toBeEnabled();
      }
    });
  });
});
