import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { createStore } from "jotai";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { editPostDialogAtom } from "@/atoms/post-edit";
import { makePost } from "@/test/factories";
import { renderWithProviders } from "@/test/render";
import { EditPostDialog } from "@/components/edit-post-dialog";
import { m } from "@/paraglide/messages.js";
import { installTestOrpc, orpc } from "@/lib/orpc";
import { POST_CACHE_KEYS } from "@/lib/post-cache";

const fakeClient = {
  post: { edit: vi.fn(), list: vi.fn(), thread: vi.fn() },
  search: { posts: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

/**
 * The dialog seeds its textarea from the cache the card rendered through, so
 * the post has to be in one before the dialog opens — same seeding shape as
 * `post-card.test.tsx`.
 */
function seedPostCache(queryClient: QueryClient, post: ReturnType<typeof makePost>): void {
  queryClient.setQueryData(orpc.post.list.key({ input: { limit: 20 } }), {
    pages: [{ items: [post], nextCursor: null }],
    pageParams: [undefined],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EditPostDialog", () => {
  it("prefills the cached text, submits the edited content, and closes once the server confirms", async () => {
    fakeClient.post.edit.mockResolvedValue({
      postId: "post-1",
      content: "fixed typo",
      editedAt: new Date(),
    });
    const store = createStore();
    store.set(editPostDialogAtom, "post-1");
    const queryClient = new QueryClient();
    seedPostCache(queryClient, makePost({ id: "post-1", content: "fixed typoo" }));
    await renderWithProviders(<EditPostDialog />, { store, queryClient, signedInAs: true });

    // The session (and with it the composer chrome) settles asynchronously —
    // findByRole awaits the textarea instead of racing the first paint. The
    // textarea is a mention combobox, so that is its accessible role.
    const textarea = await screen.findByRole("combobox");
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

  it("refetches every cached copy of the post — feeds, threads and post search", async () => {
    fakeClient.post.edit.mockResolvedValue({
      postId: "post-1",
      content: "fixed typo",
      editedAt: new Date(),
    });
    const store = createStore();
    store.set(editPostDialogAtom, "post-1");
    const queryClient = new QueryClient();
    seedPostCache(queryClient, makePost({ id: "post-1", content: "fixed typoo" }));
    const { queryClient: renderedClient } = await renderWithProviders(<EditPostDialog />, {
      store,
      queryClient,
      signedInAs: true,
    });
    const invalidate = vi.spyOn(renderedClient, "invalidateQueries");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.post_edit_submit() }));

    // The dialog opens from a card, so the post is cached in at least one of
    // the three shapes `lib/post-cache.ts` lists; the sweep must cover all of
    // them, asserted against that module's own inventory so a cache added
    // there is a failure here until it is swept.
    await waitFor(() => {
      for (const queryKey of POST_CACHE_KEYS) {
        expect(invalidate).toHaveBeenCalledWith({ queryKey });
      }
    });
    expect(invalidate).toHaveBeenCalledTimes(POST_CACHE_KEYS.length);
  });

  it("stays open with the server's refusal when the save fails — the card behind it still shows the old text", async () => {
    fakeClient.post.edit.mockRejectedValue(
      new Error("This post is under moderation review and can no longer be edited."),
    );
    const store = createStore();
    store.set(editPostDialogAtom, "post-1");
    const queryClient = new QueryClient();
    seedPostCache(queryClient, makePost({ id: "post-1", content: "fixed typoo" }));
    await renderWithProviders(<EditPostDialog />, { store, queryClient, signedInAs: true });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.post_edit_submit() }));

    // The server's own message, not the generic one: every refusal `post.edit`
    // makes has a distinct reason, and the dialog is the only place it can be
    // said.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This post is under moderation review and can no longer be edited.",
    );
    expect(store.get(editPostDialogAtom)).toBe("post-1");
  });
});
