import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { SITE_ORIGIN } from "@/lib/document-head";
import { copyPostLink, postPermalinkUrl } from "@/lib/share";
import { m } from "@/paraglide/messages.js";
import { setLocale } from "@/paraglide/runtime.js";

// Issue #307: the copy behavior itself, at the layer that owns it. The
// share-dialog and PostCard suites pin the wiring — that the dialog's button
// routes this exact post into `copyPostLink`. Rendering the same generated
// wrapper `__root.tsx` mounts is what lets the toast assertions read real
// copy off the document; plain `render` (not `renderWithProviders`) because
// the toaster has no session, router or query dependencies.

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

function mountToaster() {
  render(<Toaster theme="light" position="bottom-center" />);
}

afterEach(() => {
  cleanup();
  // Sonner's toast store outlives the unmounted toaster; clear it so a later
  // test cannot match an earlier test's toast.
  toast.dismiss();
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  void setLocale("en", { reload: false });
});

describe("copyPostLink", () => {
  it("builds the canonical absolute permalink — the same origin the og:url tags use", () => {
    expect(postPermalinkUrl("abc123")).toBe(`${SITE_ORIGIN}/post/abc123`);
  });

  it("copies the permalink and confirms it with a toast", async () => {
    const writeText = stubClipboard(vi.fn(() => Promise.resolve()));
    mountToaster();

    await copyPostLink("copied-1");

    expect(writeText).toHaveBeenCalledWith(`${SITE_ORIGIN}/post/copied-1`);
    expect(await screen.findByText(m.post_share_link_copied())).toBeInTheDocument();
  });

  // The literal strings, not the message functions: this pins that each
  // locale actually carries its own copy at render time.
  it("speaks the confirmation in the viewer's locale, with both locales pinned", async () => {
    stubClipboard(vi.fn(() => Promise.resolve()));
    mountToaster();

    await setLocale("en", { reload: false });
    await copyPostLink("locale-en");
    expect(await screen.findByText("Link copied")).toBeInTheDocument();

    await setLocale("fr", { reload: false });
    await copyPostLink("locale-fr");
    expect(await screen.findByText("Lien copié")).toBeInTheDocument();
  });

  it("reports a refused clipboard instead of masquerading as success", async () => {
    stubClipboard(vi.fn(() => Promise.reject(new Error("clipboard denied"))));
    mountToaster();

    await copyPostLink("failed-1");

    expect(await screen.findByText(m.post_share_copy_failed())).toBeInTheDocument();
  });
});
