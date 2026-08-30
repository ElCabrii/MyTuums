import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { avatarUpgradeDismissalAtom } from "@/atoms/avatar-upgrade";
import { renderWithProviders } from "@/test/render";
import { AvatarUpgradePrompt } from "@/components/avatar-upgrade-prompt";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestClient, installTestOrpc } from "@/lib/orpc";
import { installTestDisplayVariant } from "@/lib/media";

const fakeClient = {
  user: {
    uploadImage: vi.fn(() => Promise.reject(new Error("That image is too large."))),
  },
  search: {
    typeahead: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));
installTestClient(fakeClient);
installTestDisplayVariant(vi.fn((file: File) => Promise.resolve(file)));

const AVATAR_URL = "/media/legacy-avatar.webp";
const ORIGINAL_URL = "/media/legacy-avatar.orig.webp";

/**
 * A controllable stand-in for the `Image` the detector measures with: jsdom
 * loads no images, so each test drives `onload`/`onerror` itself with the
 * width a real decode would have reported.
 */
const measuredImages: MeasuredImage[] = [];

class MeasuredImage {
  complete = false;
  naturalWidth = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    measuredImages.push(this);
  }

  set src(_value: string) {
    // Deliberately inert: the test decides whether and when the load settles.
  }
}

/**
 * Mounts the prompt signed in with a retained original, then resolves the
 * measurement. Every render must first prove the prompt does not flash while
 * the measurement is still in flight.
 */
async function renderPromptWithWidth(
  naturalWidth: number,
  originalUrl: string | null = ORIGINAL_URL,
) {
  vi.stubGlobal("Image", MeasuredImage);
  const view = await renderWithProviders(
    <AvatarUpgradePrompt avatarUrl={AVATAR_URL} originalUrl={originalUrl} />,
    { signedInAs: { imageOriginal: originalUrl } },
  );

  expect(screen.queryByRole("button", { name: m.avatar_upgrade_action() })).not.toBeInTheDocument();

  const image = measuredImages.at(-1);
  expect(image).toBeDefined();
  // The await flushes the resolved measurement's microtask inside the act.
  await act(async () => {
    await Promise.resolve();
    if (image) {
      image.naturalWidth = naturalWidth;
      image.onload?.();
    }
  });

  return view;
}

describe("AvatarUpgradePrompt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    measuredImages.length = 0;
    localStorage.clear();
  });

  it("offers the one-click re-crop for a pre-#233 display variant", async () => {
    await renderPromptWithWidth(512);

    expect(screen.getByText(m.avatar_upgrade_title())).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.avatar_upgrade_action() })).toBeEnabled();
  });

  it("never prompts for a fresh upload at today's ceiling", async () => {
    await renderPromptWithWidth(1024);

    expect(screen.queryByText(m.avatar_upgrade_title())).not.toBeInTheDocument();
  });

  it("reads a failed measurement as no prompt, not as a legacy avatar", async () => {
    await renderWithProviders(
      <AvatarUpgradePrompt avatarUrl={AVATAR_URL} originalUrl={ORIGINAL_URL} />,
      { signedInAs: { imageOriginal: ORIGINAL_URL } },
    );

    const image = measuredImages.at(-1);
    act(() => image?.onerror?.());

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: m.avatar_upgrade_action() }),
      ).not.toBeInTheDocument(),
    );
  });

  it("stays quiet without an original to seed the editor from", async () => {
    // OAuth provider pictures: small display variant, no retained original —
    // the offer's fix cannot run, so the honest rendering is nothing.
    await renderPromptWithWidth(512, null);

    expect(screen.queryByText(m.avatar_upgrade_title())).not.toBeInTheDocument();
  });

  it("hides the prompt on dismiss and persists the dismissal", async () => {
    const { store, rerender } = await renderPromptWithWidth(512);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.avatar_upgrade_dismiss() }));

    expect(screen.queryByText(m.avatar_upgrade_title())).not.toBeInTheDocument();
    expect(store.get(avatarUpgradeDismissalAtom)).toBe(AVATAR_URL);

    // A fresh mount — the next visit — reads the same dismissal from storage.
    rerender(<AvatarUpgradePrompt avatarUrl={AVATAR_URL} originalUrl={ORIGINAL_URL} />);
    await waitFor(() =>
      expect(screen.queryByText(m.avatar_upgrade_title())).not.toBeInTheDocument(),
    );
  });

  it("opens the existing crop editor over the fetched original", async () => {
    await renderPromptWithWidth(512);
    const user = userEvent.setup();

    // The original arrives through the same `/media` fetch a fresh upload's
    // preview would; the editor then decodes it, which jsdom cannot do — the
    // editor still being open (in its own "unreadable" state) is the
    // observable proof it opened seeded from that fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob([], { type: "image/png" })),
        }),
      ),
    );
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.reject(new Error("not an image"))),
    );

    await user.click(screen.getByRole("button", { name: m.avatar_upgrade_action() }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(
      m.settings_image_crop_title({ label: m.settings_avatar_label() }),
    );
    expect(screen.getByText(m.validation_image_unreadable())).toBeInTheDocument();
  });

  it("surfaces a failure to fetch the original and keeps the offer up", async () => {
    await renderPromptWithWidth(512);
    const user = userEvent.setup();

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    await user.click(screen.getByRole("button", { name: m.avatar_upgrade_action() }));

    expect(await screen.findByRole("alert")).toHaveTextContent(m.avatar_upgrade_failed());
    expect(screen.getByRole("button", { name: m.avatar_upgrade_action() })).toBeEnabled();
  });

  // Issue #255's review: a failed re-crop upload used to fall back to the
  // generic message even though `uploadImageAtom` had already localized the
  // specific reason on `authErrorAtom`, which the settings-page banner reads.
  it("surfaces the upload's specific rejection over a generic message", async () => {
    // Bound rather than captured bare (see `profile-section.test.tsx`):
    // these are `URL` methods and lint refuses uncaptured references.
    const originalCreateObjectURL = globalThis.URL.createObjectURL.bind(globalThis.URL);
    const originalRevokeObjectURL = globalThis.URL.revokeObjectURL.bind(globalThis.URL);
    globalThis.URL.createObjectURL = vi.fn(() => "blob:crop");
    globalThis.URL.revokeObjectURL = vi.fn();

    try {
      await renderPromptWithWidth(512);
      const user = userEvent.setup();

      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            blob: () => Promise.resolve(new Blob([], { type: "image/png" })),
          }),
        ),
      );
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(() => Promise.resolve({ width: 800, height: 800, close: vi.fn() })),
      );

      await user.click(screen.getByRole("button", { name: m.avatar_upgrade_action() }));

      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: m.settings_image_crop_apply() }));

      expect(await screen.findByRole("alert")).toHaveTextContent(m.validation_image_too_large());
      expect(screen.queryByText(m.common_something_went_wrong())).not.toBeInTheDocument();
    } finally {
      globalThis.URL.createObjectURL = originalCreateObjectURL;
      globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});
