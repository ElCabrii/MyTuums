import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserSummary, renderWithProviders } from "@/test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { IMAGE_LIMITS } from "@my-tuums/api/constants";
import { BIO_MAX_LENGTH } from "@my-tuums/auth/rules";
import { authErrorAtom } from "@/atoms/auth";
import { authClient } from "@/lib/auth-client";
import { createDisplayVariant } from "@/lib/media";
import { ProfileSection } from "@/components/settings/profile-section";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestClient, installTestOrpc, orpc, type SearchTypeahead } from "@/lib/orpc";
import { installTestDisplayVariant } from "@/lib/media";

const fakeClient = {
  user: {
    uploadImage: vi.fn(() => Promise.resolve()),
    removeImage: vi.fn(() => Promise.resolve()),
  },
  search: {
    typeahead: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));
installTestClient(fakeClient);
installTestDisplayVariant(vi.fn((file: File) => Promise.resolve(file)));

const originalCreateImageBitmap = globalThis.createImageBitmap;
// Bound rather than captured bare: these are methods on `URL`, and handing
// an unbound reference around is what `@typescript-eslint/unbound-method`
// exists to catch.
const originalCreateObjectURL = globalThis.URL.createObjectURL.bind(globalThis.URL);
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL.bind(globalThis.URL);

/**
 * Picking a file now opens the crop editor (issue #151), which decodes the
 * source and renders it from an object URL — neither of which jsdom
 * implements. Stubbed here so the upload flow stays testable end to end; the
 * editor's own behaviour is pinned in `image-crop-dialog.test.tsx`.
 */
beforeEach(() => {
  vi.clearAllMocks();
  globalThis.createImageBitmap = vi
    .fn()
    .mockResolvedValue({ width: 800, height: 800, close: vi.fn() });
  globalThis.URL.createObjectURL = vi.fn(() => "blob:crop");
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  globalThis.createImageBitmap = originalCreateImageBitmap;
  globalThis.URL.createObjectURL = originalCreateObjectURL;
  globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
});

/** A PNG whose header declares `width`x`height`, for the megapixel pre-check. */
function pngWithHeader(width: number, height: number): File {
  const bytes = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
  ]);
  return new File([bytes], "bomb.png", { type: "image/png" });
}

/** Picks a file for one slot and commits the crop editor's default crop. */
async function pickAndApply(user: ReturnType<typeof userEvent.setup>, label: string, file: File) {
  await user.upload(screen.getByLabelText(label), file);
  const apply = await screen.findByRole("button", { name: m.settings_image_crop_apply() });
  await waitFor(() => expect(apply).toBeEnabled());
  await user.click(apply);
}

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

  it("offers @handle completion in the bio editor and accepts it with the keyboard", async () => {
    // Bios are the other free-text surface where a person writes @mentions,
    // so the completion is the same machinery the composer mounts — just
    // keyed to the bio's own scope and writing back to the bio draft atom
    // rather than a composer draft (issue #218).
    const payload: SearchTypeahead = {
      users: [
        makeUserSummary({
          id: "alice-bio",
          name: "Alice Example",
          username: "alice",
          displayUsername: "Alice",
        }),
      ],
      posts: [],
    };
    fakeClient.search.typeahead.mockResolvedValue(payload);
    const { queryClient } = await renderWithProviders(<ProfileSection />, { signedInAs: true });
    queryClient.setQueryData(orpc.search.typeahead.queryKey({ input: { q: "al" } }), payload);

    const bio = screen.getByLabelText(m.auth_field_bio());
    fireEvent.change(bio, { target: { value: "@al", selectionStart: 3, selectionEnd: 3 } });
    fireEvent.select(bio);

    const suggestion = await screen.findByRole("option", { name: /Alice Example.*@alice/i });
    fireEvent.keyDown(bio, { key: "ArrowDown" });
    // Chromium dispatches `select` after the arrow event even though the
    // editor prevented its default caret movement. That unchanged token must
    // not clear the highlight before the acceptance key arrives.
    fireEvent.select(bio);
    expect(suggestion).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(bio, { key: "Enter" });

    // The accepted handle lands in the bio draft atom the field binds — the
    // same place a typed keystroke would — not a composer-specific atom.
    await waitFor(() => expect(bio).toHaveValue("@alice"));
  });

  it("uploads and removes both avatar and banner through the transport boundary", async () => {
    const display = new File(["display"], "display.webp", { type: "image/webp" });
    vi.mocked(createDisplayVariant).mockResolvedValue(display);
    await renderWithProviders(<ProfileSection />, {
      signedInAs: { image: "/avatar.webp", bannerImage: "/banner.webp" },
    });
    const user = userEvent.setup();
    const avatar = new File(["avatar"], "avatar.png", { type: "image/png" });
    const banner = new File(["banner"], "banner.jpg", { type: "image/jpeg" });

    await pickAndApply(user, m.settings_avatar_label(), avatar);
    await waitFor(() =>
      expect(fakeClient.user.uploadImage).toHaveBeenCalledWith({
        kind: "avatar",
        original: avatar,
        display,
      }),
    );
    await pickAndApply(user, m.settings_banner_label(), banner);
    await waitFor(() =>
      expect(fakeClient.user.uploadImage).toHaveBeenCalledWith({
        kind: "banner",
        original: banner,
        display,
      }),
    );

    // The crop the editor committed is what the display variant was baked
    // from — this is the whole of issue #151's persistence story, since the
    // crop never travels as separate state.
    expect(vi.mocked(createDisplayVariant)).toHaveBeenCalledWith(avatar, "avatar", {
      x: 0.5,
      y: 0.5,
      scale: 1,
    });

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

  it("refuses a file the server would reject without opening the crop editor", async () => {
    const store = createStore();
    await renderWithProviders(<ProfileSection />, { store, signedInAs: true });
    const user = userEvent.setup();
    // Over the slot's original cap. A wrong *type* takes the same path, but is
    // not reachable here: `userEvent.upload` honours the input's `accept`, so
    // an SVG never reaches the handler in jsdom — the browser half of that is
    // pinned by the SVG spec in `e2e/tests/specs/settings.spec.ts`, where
    // Playwright delivers the file regardless of `accept`.
    const huge = new File([new Uint8Array(IMAGE_LIMITS.avatar.maxOriginalBytes + 1)], "huge.png", {
      type: "image/png",
    });

    await user.upload(screen.getByLabelText(m.settings_avatar_label()), huge);

    // There is no crop worth choosing for a file that cannot be uploaded, so
    // the refusal comes straight away rather than after an editor round trip.
    await waitFor(() => expect(store.get(authErrorAtom)).toBe(m.validation_image_too_large()));
    expect(
      screen.queryByRole("button", { name: m.settings_image_crop_apply() }),
    ).not.toBeInTheDocument();
    expect(fakeClient.user.uploadImage).not.toHaveBeenCalled();
  });

  it("refuses a decompression bomb before the editor can decode it", async () => {
    // A ~200 KB PNG whose header declares 400 MP. The byte cap never sees it,
    // and the editor decodes the source to measure it — so without a header
    // check at file-pick this allocates about a gigabyte and freezes the tab
    // merely by being selected.
    const store = createStore();
    await renderWithProviders(<ProfileSection />, { store, signedInAs: true });
    const user = userEvent.setup();

    await user.upload(
      screen.getByLabelText(m.settings_avatar_label()),
      pngWithHeader(20_000, 20_000),
    );

    await waitFor(() => expect(store.get(authErrorAtom)).toBe(m.validation_image_too_large()));
    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: m.settings_image_crop_apply() }),
    ).not.toBeInTheDocument();
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

    await pickAndApply(user, m.settings_avatar_label(), avatar);
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
