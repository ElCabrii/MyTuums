import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { SITE_ORIGIN } from "@/lib/document-head";
import { postPermalinkUrl, sharePost } from "@/lib/share";
import { m } from "@/paraglide/messages.js";
import { setLocale } from "@/paraglide/runtime.js";

// Issue #307: the share behavior itself, at the layer that owns it. The
// PostCard suite pins only the wiring — that a click routes this exact post
// into `sharePost`. Rendering the same generated wrapper `__root.tsx`
// mounts is what lets the toast assertions read real copy off the document;
// plain `render` (not `renderWithProviders`) because the toaster has no
// session, router or query dependencies.

/**
 * jsdom ships neither `navigator.share` nor a writable clipboard, so
 * `defineProperty` is the only way to substitute either — the same
 * substitution the security-sections suite uses. Every test installs what it
 * needs; the afterEach restores absence so no later test inherits a
 * "share-capable" or "clipboard-capable" navigator it did not ask for.
 */
function stubShare(share: () => Promise<void>) {
  Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });
  return share;
}

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
  Object.defineProperty(navigator, "share", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  void setLocale("en", { reload: false });
});

describe("sharePost", () => {
  it("builds the canonical absolute permalink — the same origin the og:url tags use", () => {
    expect(postPermalinkUrl("abc123")).toBe(`${SITE_ORIGIN}/post/abc123`);
  });

  it("hands the permalink to the system share sheet when the platform offers one", async () => {
    const share = stubShare(vi.fn(() => Promise.resolve()));
    const writeText = stubClipboard(vi.fn(() => Promise.resolve()));
    mountToaster();

    await sharePost("shared-1");

    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ url: `${SITE_ORIGIN}/post/shared-1` });
    // The sheet answered; the clipboard fallback stays out of it.
    expect(writeText).not.toHaveBeenCalled();
  });

  it("treats a dismissed sheet as done: no clipboard copy, no toast", async () => {
    const share = stubShare(vi.fn(() => Promise.reject(new DOMException("aborted", "AbortError"))));
    const writeText = stubClipboard(vi.fn(() => Promise.resolve()));
    mountToaster();

    await sharePost("dismissed-1");

    expect(share).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText(/copied|impossible/i)).not.toBeInTheDocument();
  });

  it("copies the permalink when no sheet exists, and confirms it with a toast", async () => {
    const writeText = stubClipboard(vi.fn(() => Promise.resolve()));
    mountToaster();

    await sharePost("copied-1");

    expect(writeText).toHaveBeenCalledWith(`${SITE_ORIGIN}/post/copied-1`);
    expect(await screen.findByText(m.post_share_link_copied())).toBeInTheDocument();
  });

  // The literal strings, not the message functions: this pins that each
  // locale actually carries its own copy at render time.
  it("speaks the confirmation in the viewer's locale, with both locales pinned", async () => {
    stubClipboard(vi.fn(() => Promise.resolve()));
    mountToaster();

    await setLocale("en", { reload: false });
    await sharePost("locale-en");
    expect(await screen.findByText("Link copied")).toBeInTheDocument();

    await setLocale("fr", { reload: false });
    await sharePost("locale-fr");
    expect(await screen.findByText("Lien copié")).toBeInTheDocument();
  });

  it("reports a refused clipboard instead of masquerading as success", async () => {
    stubClipboard(vi.fn(() => Promise.reject(new Error("clipboard denied"))));
    mountToaster();

    await sharePost("failed-1");

    expect(await screen.findByText(m.post_share_copy_failed())).toBeInTheDocument();
  });
});
