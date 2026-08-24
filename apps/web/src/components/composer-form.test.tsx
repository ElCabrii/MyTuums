import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { POST_MAX_LENGTH } from "@my-tuums/api/constants";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc, orpc, type SearchTypeahead } from "@/lib/orpc";
import { renderWithProviders, makeUserSummary } from "@/test/render";
import { ComposerForm } from "@/components/composer-form";
import { m } from "@/paraglide/messages.js";

const fakeClient = { search: { typeahead: vi.fn() } };
installTestOrpc(createTanstackQueryUtils(fakeClient));

const VALID_PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

/**
 * ComposerForm is fully controlled — it owns no state of its own (see its
 * source comment), so every scenario here is a distinct `value`/`isPending`
 * prop rather than simulated typing. That matches how the real callers
 * (the atoms backing the draft) drive it.
 */
async function renderComposer(overrides: Partial<ComponentProps<typeof ComposerForm>> = {}) {
  const onSubmit = overrides.onSubmit ?? vi.fn();
  const onValueChange = overrides.onValueChange ?? vi.fn();

  const result = await renderWithProviders(
    <ComposerForm
      author={{ name: "Alex Mercer", image: null }}
      value=""
      onValueChange={onValueChange}
      onSubmit={onSubmit}
      isPending={false}
      errorMessage={null}
      placeholder="What's happening?"
      submitLabel="Post"
      {...overrides}
    />,
  );

  return { onSubmit, onValueChange, ...result };
}

function StatefulComposer({
  initialValue,
  mentionScope,
}: {
  initialValue: string;
  mentionScope: string;
}) {
  const [value, setValue] = useState(initialValue);

  return (
    <ComposerForm
      author={{ name: "Alex Mercer", image: null }}
      value={value}
      onValueChange={setValue}
      onSubmit={() => {}}
      isPending={false}
      errorMessage={null}
      placeholder="What's happening?"
      submitLabel="Post"
      mentionScope={mentionScope}
    />
  );
}

describe("ComposerForm", () => {
  it("disables submit when the value is empty", async () => {
    await renderComposer({ value: "" });
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
  });

  it("disables submit when the value is whitespace-only", async () => {
    await renderComposer({ value: "   " });
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
  });

  it("calls onSubmit with the trimmed body, not the raw value", async () => {
    const onSubmit = vi.fn();
    await renderComposer({ value: "  hello  ", onSubmit });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Post" }));

    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  it("starts the remaining-character counter at POST_MAX_LENGTH", async () => {
    await renderComposer({ value: "" });
    expect(screen.getByText(String(POST_MAX_LENGTH))).toBeInTheDocument();
  });

  it("goes negative past the limit and disables submit", async () => {
    const over = "a".repeat(POST_MAX_LENGTH + 5);
    await renderComposer({ value: over });

    expect(screen.getByText("-5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
  });

  it("is submittable at exactly POST_MAX_LENGTH characters", async () => {
    await renderComposer({ value: "a".repeat(POST_MAX_LENGTH) });
    expect(screen.getByRole("button", { name: "Post" })).not.toBeDisabled();
  });

  it("is not submittable one character past POST_MAX_LENGTH", async () => {
    await renderComposer({ value: "a".repeat(POST_MAX_LENGTH + 1) });
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
  });

  it("disables the textarea and swaps the send icon for a spinner while pending", async () => {
    const { container } = await renderComposer({ value: "hello", isPending: true });

    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // The spinner and the send icon are both unlabelled lucide svgs; the
    // `animate-spin` class the source applies only to Loader2 is the
    // reliable signal that it — not Send — is what's rendered.
    expect(container.querySelector("button[type='submit'] svg.animate-spin")).toBeInTheDocument();
  });

  it("keeps short drafts compact and caps a near-limit multiline draft with scrolling", async () => {
    await renderWithProviders(<StatefulComposer initialValue="Short" mentionScope="auto-grow" />);
    const textarea = screen.getByRole<HTMLTextAreaElement>("combobox");
    let scrollHeight = 56;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    fireEvent.change(textarea, { target: { value: "Short draft" } });
    expect(textarea.style.height).toBe("56px");
    expect(textarea.style.overflowY).toBe("hidden");

    const nearLimit = "line\n".repeat(99) + "line";
    expect(nearLimit.length).toBe(499);
    scrollHeight = 480;
    fireEvent.change(textarea, { target: { value: nearLimit } });

    expect(textarea.style.height).toBe("256px");
    expect(textarea.style.overflowY).toBe("auto");
    expect(screen.getByText("1", { exact: true })).toBeInTheDocument();
  });

  it("shows the send icon, not a spinner, when idle", async () => {
    const { container } = await renderComposer({ value: "hello", isPending: false });
    expect(
      container.querySelector("button[type='submit'] svg.animate-spin"),
    ).not.toBeInTheDocument();
  });

  it("renders errorMessage in an alert, and renders no alert when null", async () => {
    const withError = await renderComposer({ errorMessage: "Could not post. Try again." });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not post. Try again.");
    withError.unmount();

    await renderComposer({ errorMessage: null });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the header slot above the textarea", async () => {
    await renderComposer({ header: <p>Replying to @alexmercer</p> });

    const header = screen.getByText("Replying to @alexmercer");
    const textarea = screen.getByRole<HTMLTextAreaElement>("combobox");

    expect(
      header.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not call onSubmit on a form submit event when canSubmit is false (guard is in the handler, not just the disabled attribute)", async () => {
    const onSubmit = vi.fn();
    const { container } = await renderComposer({ value: "   ", onSubmit });

    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("offers a matching handle and accepts it with the keyboard", async () => {
    const payload: SearchTypeahead = {
      users: [
        makeUserSummary({
          id: "alice-1",
          name: "Alice Example",
          username: "alice",
          displayUsername: "Alice",
        }),
      ],
      posts: [],
    };
    fakeClient.search.typeahead.mockResolvedValue(payload);
    const onValueChange = vi.fn();
    const queryClient = (
      await renderComposer({
        value: "@al",
        onValueChange,
        mentionScope: "mention-keyboard",
      })
    ).queryClient;
    queryClient.setQueryData(orpc.search.typeahead.queryKey({ input: { q: "al" } }), payload);

    const textarea = screen.getByRole<HTMLTextAreaElement>("combobox");
    fireEvent.change(textarea, {
      target: { value: "@al", selectionStart: 3, selectionEnd: 3 },
    });
    textarea.setSelectionRange(3, 3);
    fireEvent.select(textarea);

    const suggestion = await screen.findByRole("option", { name: /Alice Example.*@alice/i });
    expect(suggestion).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    // Chromium dispatches `select` after the arrow event even though the
    // composer prevented its default caret movement. That unchanged token
    // must not clear the highlight before the acceptance key arrives.
    fireEvent.select(textarea);
    expect(suggestion).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onValueChange).toHaveBeenCalledWith("@alice");
  });

  it("moves the highlight with both arrows and accepts a middle-token completion with Tab", async () => {
    const payload: SearchTypeahead = {
      users: [
        makeUserSummary({
          id: "alice-2",
          name: "Alice Example",
          username: "alice",
          displayUsername: "Alice",
        }),
        makeUserSummary({
          id: "albert-2",
          name: "Albert Example",
          username: "albert",
          displayUsername: "Albert",
        }),
      ],
      posts: [],
    };
    fakeClient.search.typeahead.mockResolvedValue(payload);
    const onValueChange = vi.fn();
    const rendered = await renderComposer({
      value: "before @alworld after",
      onValueChange,
      mentionScope: "mention-arrows-tab",
    });
    rendered.queryClient.setQueryData(
      orpc.search.typeahead.queryKey({ input: { q: "al" } }),
      payload,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("combobox");
    fireEvent.change(textarea, {
      target: { value: "before @alworld after", selectionStart: 10, selectionEnd: 10 },
    });
    textarea.setSelectionRange(10, 10);
    fireEvent.select(textarea);

    const options = await screen.findAllByRole("option");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(onValueChange).toHaveBeenCalledWith("before @alice after");
  });

  it("dismisses an open mention popup with Escape", async () => {
    const payload: SearchTypeahead = {
      users: [
        makeUserSummary({
          id: "alice-escape",
          name: "Alice Example",
          username: "alice",
          displayUsername: "Alice",
        }),
      ],
      posts: [],
    };
    fakeClient.search.typeahead.mockResolvedValue(payload);
    const rendered = await renderComposer({ value: "@al", mentionScope: "mention-escape" });
    rendered.queryClient.setQueryData(
      orpc.search.typeahead.queryKey({ input: { q: "al" } }),
      payload,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("combobox");
    fireEvent.change(textarea, { target: { value: "@al", selectionStart: 3, selectionEnd: 3 } });
    textarea.setSelectionRange(3, 3);
    fireEvent.select(textarea);
    await screen.findByRole("option", { name: /Alice Example.*@alice/i });

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not render an empty mention popup when no account matches", async () => {
    fakeClient.search.typeahead.mockResolvedValue({ users: [], posts: [] });
    const queryClient = (
      await renderComposer({
        value: "@zz",
        mentionScope: "mention-empty",
      })
    ).queryClient;
    queryClient.setQueryData(orpc.search.typeahead.queryKey({ input: { q: "zz" } }), {
      users: [],
      posts: [],
    });

    const textarea = screen.getByRole<HTMLTextAreaElement>("combobox");
    fireEvent.change(textarea, {
      target: { value: "@zz", selectionStart: 3, selectionEnd: 3 },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("accepts image selections through the accessible file control", async () => {
    const onAttachmentsChange = vi.fn();
    await renderComposer({ value: "hello", onAttachmentsChange, attachments: [] });

    const input = screen.getByLabelText<HTMLInputElement>(m.post_add_images());
    const first = new File([VALID_PNG_BYTES], "first.png", { type: "image/png" });
    const second = new File([VALID_PNG_BYTES], "second.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [first, second] } });

    await waitFor(() =>
      expect(onAttachmentsChange).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ file: first }),
          expect.objectContaining({ file: second }),
        ]),
      ),
    );
  });

  it("keeps submit disabled until the selected image has finished validation", async () => {
    const file = new File([VALID_PNG_BYTES], "pending.png", { type: "image/png" });

    await renderComposer({
      value: "hello",
      onAttachmentsChange: vi.fn(),
      attachments: [],
    });

    fireEvent.change(screen.getByLabelText<HTMLInputElement>(m.post_add_images()), {
      target: { files: [file] },
    });
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();

    await waitFor(() => expect(screen.getByRole("button", { name: "Post" })).not.toBeDisabled());
  });

  it("rejects malformed and declared-type-mismatched image bytes", async () => {
    const onAttachmentsChange = vi.fn();
    await renderComposer({ value: "hello", onAttachmentsChange, attachments: [] });

    const input = screen.getByLabelText<HTMLInputElement>(m.post_add_images());
    const malformed = new File([new Uint8Array([1, 2, 3])], "malformed.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [malformed] } });
    await screen.findByRole("alert");
    expect(onAttachmentsChange).not.toHaveBeenCalled();

    const mismatch = new File([VALID_PNG_BYTES], "mismatch.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [mismatch] } });
    await waitFor(() => expect(onAttachmentsChange).not.toHaveBeenCalled());
    expect(screen.getByRole("alert")).toHaveTextContent(m.post_image_invalid());
  });

  it("clears a stale image error after a later valid selection", async () => {
    const onAttachmentsChange = vi.fn();
    await renderComposer({ value: "hello", onAttachmentsChange, attachments: [] });

    const input = screen.getByLabelText<HTMLInputElement>(m.post_add_images());
    fireEvent.change(input, {
      target: {
        files: [new File([new Uint8Array([1, 2, 3])], "bad.png", { type: "image/png" })],
      },
    });
    await screen.findByRole("alert");

    const valid = new File([VALID_PNG_BYTES], "valid.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [valid] } });
    await waitFor(() =>
      expect(onAttachmentsChange).toHaveBeenCalledWith([expect.objectContaining({ file: valid })]),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
