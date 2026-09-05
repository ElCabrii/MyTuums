import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  POST_ATTACHMENT_MAX_BYTES,
  POST_ATTACHMENT_MAX_TOTAL_BYTES,
  POST_MAX_LENGTH,
} from "@my-tuums/api/constants";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc, orpc, type SearchTypeahead } from "@/lib/orpc";
import { makeUserSummary } from "@/test/factories";
import { renderWithProviders } from "@/test/render";
import { ComposerForm } from "@/components/composer-form";
import { installTestPostAttachment } from "@/lib/media";
import { m } from "@/paraglide/messages.js";

const fakeClient = { search: { typeahead: vi.fn() } };
installTestOrpc(createTanstackQueryUtils(fakeClient));

/**
 * Every selection runs through the post-attachment pipeline (`lib/media.ts`)
 * before it joins the draft. jsdom implements neither `createImageBitmap` nor
 * a canvas, so these tests substitute an identity processor and exercise the
 * flow around it; what processing itself guarantees is pinned in
 * `lib/media.dom.test.ts` and proven end to end in compose.spec.ts.
 */
const identityProcessor = (file: File) => Promise.resolve(file);

beforeEach(() => {
  installTestPostAttachment(identityProcessor);
});

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

describe("ComposerForm", () => {
  it("refuses a body with nothing in it once trimmed", async () => {
    for (const value of ["", "   ", "\n\t "]) {
      const rendered = await renderComposer({ value });
      expect(screen.getByRole("button", { name: "Post" }), value).toBeDisabled();
      rendered.unmount();
    }
  });

  it("calls onSubmit with the trimmed body, not the raw value", async () => {
    const onSubmit = vi.fn();
    await renderComposer({ value: "  hello  ", onSubmit });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Post" }));

    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  // The same cross-field rule `post.create` enforces (issue #202): text,
  // images, or both — never neither. A blank body is submittable only while
  // at least one validated attachment rides along, and the body arrives as "".
  it("enables submit for a whitespace-only body once a validated attachment rides along", async () => {
    const onSubmit = vi.fn();
    const file = new File([VALID_PNG_BYTES], "first.png", { type: "image/png" });
    await renderComposer({
      value: "   ",
      onSubmit,
      onAttachmentsChange: vi.fn(),
      attachments: [{ id: "first", file }],
    });

    const submit = screen.getByRole("button", { name: "Post" });
    expect(submit).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledWith("", [{ id: "first", file }]);
  });

  // One test, both sides of the only boundary there is: the counter counts
  // down from POST_MAX_LENGTH, the last accepted length is exactly it, and
  // the first refused length is one past.
  it("counts down to POST_MAX_LENGTH and refuses the first character past it", async () => {
    const empty = await renderComposer({ value: "" });
    expect(screen.getByText(String(POST_MAX_LENGTH))).toBeInTheDocument();
    empty.unmount();

    const atLimit = await renderComposer({ value: "a".repeat(POST_MAX_LENGTH) });
    expect(screen.getByRole("button", { name: "Post" })).not.toBeDisabled();
    atLimit.unmount();

    const over = await renderComposer({ value: "a".repeat(POST_MAX_LENGTH + 1) });
    expect(screen.getByText("-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
    over.unmount();
  });

  it("disables the textarea and swaps the send icon for a spinner while pending", async () => {
    const { container } = await renderComposer({ value: "hello", isPending: true });

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // The spinner and the send icon are both unlabelled lucide svgs; the
    // `animate-spin` class the source applies only to Loader2 is the
    // reliable signal that it — not Send — is what's rendered.
    expect(container.querySelector("button[type='submit'] svg.animate-spin")).toBeInTheDocument();
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
    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");

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
      games: [],
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

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
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
      games: [],
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

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
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
      games: [],
      posts: [],
    };
    fakeClient.search.typeahead.mockResolvedValue(payload);
    const rendered = await renderComposer({ value: "@al", mentionScope: "mention-escape" });
    rendered.queryClient.setQueryData(
      orpc.search.typeahead.queryKey({ input: { q: "al" } }),
      payload,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(textarea, { target: { value: "@al", selectionStart: 3, selectionEnd: 3 } });
    textarea.setSelectionRange(3, 3);
    fireEvent.select(textarea);
    await screen.findByRole("option", { name: /Alice Example.*@alice/i });

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not render an empty mention popup when no account matches", async () => {
    fakeClient.search.typeahead.mockResolvedValue({ users: [], games: [], posts: [] });
    const queryClient = (
      await renderComposer({
        value: "@zz",
        mentionScope: "mention-empty",
      })
    ).queryClient;
    queryClient.setQueryData(orpc.search.typeahead.queryKey({ input: { q: "zz" } }), {
      users: [],
      games: [],
      posts: [],
    });

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
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

  it("locks attachment edits while a selection is being validated", async () => {
    const first = new File([VALID_PNG_BYTES], "first.png", { type: "image/png" });
    const second = new File([VALID_PNG_BYTES], "second.png", { type: "image/png" });
    const selected = new File([VALID_PNG_BYTES], "selected.png", { type: "image/png" });

    await renderComposer({
      value: "hello",
      onAttachmentsChange: vi.fn(),
      attachments: [
        { id: "first", file: first },
        { id: "second", file: second },
      ],
    });

    fireEvent.change(screen.getByLabelText<HTMLInputElement>(m.post_add_images()), {
      target: { files: [selected] },
    });

    const moveFirstRight = screen.getByRole("button", {
      name: m.post_image_move_right({ name: first.name }),
    });
    const removeFirst = screen.getByRole("button", {
      name: m.post_image_remove({ name: first.name }),
    });
    expect(moveFirstRight).toBeDisabled();
    expect(removeFirst).toBeDisabled();

    await waitFor(() => {
      expect(moveFirstRight).not.toBeDisabled();
      expect(removeFirst).not.toBeDisabled();
    });
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
    expect(await screen.findByRole("alert")).toHaveTextContent(m.post_image_invalid());
    expect(onAttachmentsChange).not.toHaveBeenCalled();
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

  it("attaches what the processing pipeline returns, not the picked file", async () => {
    // The draft must carry the re-encoded object (issue #207): the picked
    // bytes are exactly what must never reach storage.
    const picked = new File([VALID_PNG_BYTES], "picked.png", { type: "image/png" });
    const processed = new File([VALID_PNG_BYTES], "processed.webp", { type: "image/webp" });
    installTestPostAttachment(() => Promise.resolve(processed));

    const onAttachmentsChange = vi.fn();
    await renderComposer({ value: "hello", onAttachmentsChange, attachments: [] });

    fireEvent.change(screen.getByLabelText<HTMLInputElement>(m.post_add_images()), {
      target: { files: [picked] },
    });

    await waitFor(() =>
      expect(onAttachmentsChange).toHaveBeenCalledWith([
        expect.objectContaining({ file: processed }),
      ]),
    );
  });

  it("refuses a file the processing pipeline cannot encode", async () => {
    installTestPostAttachment(() => Promise.reject(new Error("unencodable")));
    const onAttachmentsChange = vi.fn();
    await renderComposer({ value: "hello", onAttachmentsChange, attachments: [] });

    fireEvent.change(screen.getByLabelText<HTMLInputElement>(m.post_add_images()), {
      target: { files: [new File([VALID_PNG_BYTES], "doomed.png", { type: "image/png" })] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(m.post_image_invalid());
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("caps the batch at the total-bytes budget against processed sizes, not picked sizes", async () => {
    // A re-encode can outweigh its source — a PNG fallback on a browser
    // without WebP encode — so the total budget must be measured against what
    // is actually uploaded (the processed objects), never the picked bytes.
    // Otherwise a staged batch could pass the client guard and exceed the
    // server's POST_ATTACHMENT_MAX_TOTAL_BYTES (issue #207 follow-up).

    // Pin the cap relationship this scenario depends on, so a future change
    // to either constant turns this into a failure rather than a silent no-op.
    expect(2 * POST_ATTACHMENT_MAX_BYTES).toBeLessThanOrEqual(POST_ATTACHMENT_MAX_TOTAL_BYTES);
    expect(3 * POST_ATTACHMENT_MAX_BYTES).toBeGreaterThan(POST_ATTACHMENT_MAX_TOTAL_BYTES);

    // Each picked file is a tiny valid PNG (under both caps); the processor
    // stands in for the inflation, returning a max-size object every time.
    const inflated = new Uint8Array(POST_ATTACHMENT_MAX_BYTES);
    installTestPostAttachment((file: File) =>
      Promise.resolve(new File([inflated], file.name, { type: "image/webp" })),
    );

    const onAttachmentsChange = vi.fn();
    await renderComposer({ value: "hello", onAttachmentsChange, attachments: [] });

    fireEvent.change(screen.getByLabelText<HTMLInputElement>(m.post_add_images()), {
      target: {
        files: [
          new File([VALID_PNG_BYTES], "a.png", { type: "image/png" }),
          new File([VALID_PNG_BYTES], "b.png", { type: "image/png" }),
          new File([VALID_PNG_BYTES], "c.png", { type: "image/png" }),
        ],
      },
    });

    // Two max-size objects fit within the total cap; the third would exceed
    // it, so it is refused and the loop stops with the limit message.
    await waitFor(() => expect(onAttachmentsChange.mock.calls.at(-1)?.[0]).toHaveLength(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(m.post_image_limit());
  });
});

describe("ComposerForm game tags (issue #314, Q4)", () => {
  // `renderComposer` lives in the module scope above and mounts the same
  // form the mention tests drive; these tests only swap the payload's games
  // half in.

  it("suggests games while typing a #tag and writes the catalog's full key on accept", async () => {
    const payload: SearchTypeahead = {
      users: [],
      games: [
        {
          slug: "world-of-warcraft",
          hashtagKey: "worldofwarcraft",
          name: "World of Warcraft",
          coverMediaPath: null,
          firstReleaseYear: 2004,
        },
      ],
      posts: [],
    };
    fakeClient.search.typeahead.mockResolvedValue(payload);
    const onValueChange = vi.fn();
    const rendered = await renderComposer({
      value: "raiding #wow tonight",
      onValueChange,
      mentionScope: "game-tag-accept",
    });
    rendered.queryClient.setQueryData(
      orpc.search.typeahead.queryKey({ input: { q: "wow" } }),
      payload,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    // Caret after `#wo` (index 10).
    fireEvent.change(textarea, {
      target: { value: "raiding #wow tonight", selectionStart: 10, selectionEnd: 10 },
    });
    textarea.setSelectionRange(10, 10);
    fireEvent.select(textarea);

    const option = await screen.findByRole("option", { name: /World of Warcraft/ });
    expect(option).toHaveTextContent("#worldofwarcraft");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onValueChange).toHaveBeenCalledWith("raiding #worldofwarcraft tonight");
  });

  it("keeps @handle completion unaffected while a tag popup is a different surface", async () => {
    // Same query string through the @ path still offers users: the two token
    // kinds share one typeahead but never one popup.
    const payload: SearchTypeahead = {
      users: [makeUserSummary({ id: "u-wow", name: "Wow Player", username: "wowplayer" })],
      games: [],
      posts: [],
    };
    fakeClient.search.typeahead.mockResolvedValue(payload);
    const rendered = await renderComposer({ value: "@wow", mentionScope: "game-tag-mention" });
    rendered.queryClient.setQueryData(
      orpc.search.typeahead.queryKey({ input: { q: "wow" } }),
      payload,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(textarea, { target: { value: "@wow", selectionStart: 4, selectionEnd: 4 } });
    textarea.setSelectionRange(4, 4);
    fireEvent.select(textarea);

    await screen.findByRole("option", { name: /Wow Player.*@wowplayer/i });
  });
});
