import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { POST_MAX_LENGTH } from "@my-tuums/api/constants";
import { renderWithProviders } from "@/test/render";
import { ComposerForm } from "@/components/composer-form";

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

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
    // The spinner and the send icon are both unlabelled lucide svgs; the
    // `animate-spin` class the source applies only to Loader2 is the
    // reliable signal that it — not Send — is what's rendered.
    expect(container.querySelector("button[type='submit'] svg.animate-spin")).toBeInTheDocument();
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
    const textarea = screen.getByRole("textbox");

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
});
