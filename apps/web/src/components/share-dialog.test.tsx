import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { makeAuthor, makePost } from "@/test/factories";
import { renderWithProviders } from "@/test/render";
import { installTestOrpc } from "@/lib/orpc";
import { shareDialogAtom } from "@/atoms/share-dialog";
import { ShareDialog } from "@/components/share-dialog";
import { SITE_ORIGIN } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

// The dialog itself runs no queries and no mutations, but the module graph
// reaches `lib/orpc`'s real client (ProfileLink → router, the session atoms
// `renderWithProviders` mounts), and this suite's `user.click`s go dead
// without the test client swapped in — the same module-level convention
// every other dialog suite follows (see delete-post-dialog.test.tsx).
const fakeClient = {
  post: { list: vi.fn(), thread: vi.fn() },
  search: { posts: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

/**
 * jsdom ships no writable clipboard, so `defineProperty` is the only way to
 * substitute it — the same substitution the security-sections suite uses.
 * The afterEach restores absence so no later test inherits a
 * "clipboard-capable" navigator it did not ask for.
 */
function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
    writable: true,
  });
});

// Issue #307: the share dialog. Note on the driver: the copy buttons are
// clicked with `fireEvent`, not `userEvent` — in jsdom, user-event's full
// pointer sequence never reaches React's delegated listeners for this
// portaled base-ui dialog (the same clicks work through `fireEvent`, and
// the component works in the browser; every isolated factor was bisected
// without reproducing it). What is pinned is the dialog's observable
// behavior, not the event machinery.

describe("ShareDialog", () => {
  it("previews the targeted post and copies its canonical permalink", async () => {
    const store = createStore();
    const post = makePost({
      id: "share-me",
      content: "A post worth sharing",
      author: makeAuthor({ name: "Sharer", username: "sharer" }),
    });
    store.set(shareDialogAtom, post);
    const writeText = stubClipboard(vi.fn(() => Promise.resolve()));
    await renderWithProviders(<ShareDialog />, { store });

    expect(
      await screen.findByRole("heading", { name: m.post_share_dialog_title() }),
    ).toBeInTheDocument();
    // The preview is the post the reader will land on: author and words.
    expect(screen.getByText("A post worth sharing")).toBeInTheDocument();
    expect(screen.getByText("@sharer")).toBeInTheDocument();
    // The URL row shows the absolute canonical permalink.
    expect(screen.getByText(`${SITE_ORIGIN}/post/share-me`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m.post_share_copy_link() }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${SITE_ORIGIN}/post/share-me`));
  });

  it("stays open after a copy — the URL stays readable and re-copiable", async () => {
    const store = createStore();
    const post = makePost({ id: "twice" });
    store.set(shareDialogAtom, post);
    const writeText = stubClipboard(vi.fn(() => Promise.resolve()));
    await renderWithProviders(<ShareDialog />, { store });

    const copyButton = screen.getByRole("button", { name: m.post_share_copy_link() });
    fireEvent.click(copyButton);
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(store.get(shareDialogAtom)).toBe(post);
  });

  it("closes on dismiss, clearing the target", async () => {
    const store = createStore();
    store.set(shareDialogAtom, makePost());
    await renderWithProviders(<ShareDialog />, { store });

    expect(
      await screen.findByRole("heading", { name: m.post_share_dialog_title() }),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(store.get(shareDialogAtom)).toBeNull());
  });
});
