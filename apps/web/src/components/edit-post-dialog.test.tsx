import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { editPostDialogAtom, type EditPostTarget } from "@/atoms/post-edit";
import { renderWithProviders } from "@/test/render";
import { EditPostDialog } from "@/components/edit-post-dialog";
import { m } from "@/paraglide/messages.js";
import { installTestOrpc } from "@/lib/orpc";
import { POST_CACHE_KEYS } from "@/lib/post-cache";

const fakeClient = {
  post: { edit: vi.fn(), list: vi.fn(), thread: vi.fn() },
  search: { posts: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

/**
 * The card hands the atom a snapshot of the post as it rendered — text and
 * attachment count included — so the dialog never reads a cache. Opening it
 * is exactly what the kebab's click does.
 */
function openDialog(store: ReturnType<typeof createStore>, target: EditPostTarget) {
  store.set(editPostDialogAtom, target);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EditPostDialog", () => {
  it("prefills the target's text, submits the edited content, and closes once the server confirms", async () => {
    fakeClient.post.edit.mockResolvedValue({
      postId: "post-1",
      content: "fixed typo",
      editedAt: new Date(),
    });
    const store = createStore();
    openDialog(store, { postId: "post-1", content: "fixed typoo", attachmentCount: 0 });
    await renderWithProviders(<EditPostDialog />, { store, signedInAs: true });

    // The session (and with it the composer chrome) settles asynchronously —
    // findByRole awaits the textarea instead of racing the first paint. The
    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox");
    expect(textarea).toHaveValue("fixed typoo");

    const user = userEvent.setup();
    await user.clear(textarea);
    await user.type(textarea, "fixed typo");
    await user.click(screen.getByRole("button", { name: m.post_edit_submit() }));

    await waitFor(() =>
      expect(fakeClient.post.edit).toHaveBeenCalledWith(
        { postId: "post-1", content: "fixed typo" },
        expect.anything(),
      ),
    );
    await waitFor(() => expect(store.get(editPostDialogAtom)).toBeNull());
  });

  it("can save the text down to empty on a post that carries images — the cross-field rule against server state", async () => {
    fakeClient.post.edit.mockResolvedValue({
      postId: "post-1",
      content: "",
      editedAt: new Date(),
    });
    const store = createStore();
    openDialog(store, { postId: "post-1", content: "a caption", attachmentCount: 1 });
    await renderWithProviders(<EditPostDialog />, { store, signedInAs: true });

    const user = userEvent.setup();
    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox");
    await user.clear(textarea);

    // The post's own images satisfy "text, images, or both" (issue #202), so
    // the cleared text is submittable — the API allows this edit, and the UI
    // no longer refuses what the server accepts.
    const submit = screen.getByRole("button", { name: m.post_edit_submit() });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(fakeClient.post.edit).toHaveBeenCalledWith(
        { postId: "post-1", content: "" },
        expect.anything(),
      ),
    );
  });

  it("refuses an empty text on an imageless post — the composer's own cross-field rule", async () => {
    const store = createStore();
    openDialog(store, { postId: "post-1", content: "just text", attachmentCount: 0 });
    await renderWithProviders(<EditPostDialog />, { store, signedInAs: true });

    const user = userEvent.setup();
    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox");
    await user.clear(textarea);

    expect(screen.getByRole("button", { name: m.post_edit_submit() })).toBeDisabled();
    expect(fakeClient.post.edit).not.toHaveBeenCalled();
  });

  it("refetches every cached copy of the post — feeds, threads and post search", async () => {
    fakeClient.post.edit.mockResolvedValue({
      postId: "post-1",
      content: "fixed typo",
      editedAt: new Date(),
    });
    const store = createStore();
    openDialog(store, { postId: "post-1", content: "fixed typo", attachmentCount: 0 });
    const { queryClient } = await renderWithProviders(<EditPostDialog />, {
      store,
      signedInAs: true,
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.post_edit_submit() }));

    // The sweep must cover every shape `lib/post-cache.ts` lists, asserted
    // against that module's own inventory so a cache added there is a failure
    // here until it is swept.
    await waitFor(() => {
      for (const queryKey of POST_CACHE_KEYS) {
        expect(invalidate).toHaveBeenCalledWith({ queryKey });
      }
    });
    expect(invalidate).toHaveBeenCalledTimes(POST_CACHE_KEYS.length);
  });

  it("stays open with the server's refusal when the save fails — the card behind it still shows the old text", async () => {
    fakeClient.post.edit.mockRejectedValue(
      new Error("This post was removed by a moderator and can no longer be edited."),
    );
    const store = createStore();
    openDialog(store, { postId: "post-1", content: "fixed typoo", attachmentCount: 0 });
    await renderWithProviders(<EditPostDialog />, { store, signedInAs: true });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.post_edit_submit() }));

    // The server's own message, not the generic one: every refusal `post.edit`
    // makes has a distinct reason, and the dialog is the only place it can be
    // said. Asserted through the message key rather than the raw string: the
    // alert must route through `localizeEditPostError`, or the refusal renders
    // untranslated in every locale but English.
    expect(await screen.findByRole("alert")).toHaveTextContent(m.post_edit_removed());
    expect(store.get(editPostDialogAtom)).not.toBeNull();
  });
});
