import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { deletePostDialogAtom } from "@/atoms/post-delete";
import { renderWithProviders } from "@/test/render";
import { DeletePostDialog } from "@/components/delete-post-dialog";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";
import { POST_CACHE_KEYS } from "@/lib/post-cache";

const fakeClient = {
  post: { delete: vi.fn(), list: vi.fn(), thread: vi.fn() },
  search: { posts: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DeletePostDialog", () => {
  it("submits the targeted post id and closes once the server confirms", async () => {
    fakeClient.post.delete.mockResolvedValue({ postId: "post-1", deletedAt: new Date() });
    const store = createStore();
    store.set(deletePostDialogAtom, "post-1");
    await renderWithProviders(<DeletePostDialog />, { store });

    expect(await screen.findByRole("heading", { name: m.post_delete_title() })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.post_delete_submit() }));

    await waitFor(() =>
      expect(fakeClient.post.delete).toHaveBeenCalledWith({ postId: "post-1" }, expect.anything()),
    );
    await waitFor(() => expect(store.get(deletePostDialogAtom)).toBeNull());
  });

  it("refetches every cached copy of the post — feeds, threads and post search", async () => {
    fakeClient.post.delete.mockResolvedValue({ postId: "post-1", deletedAt: new Date() });
    const store = createStore();
    store.set(deletePostDialogAtom, "post-1");
    const { queryClient } = await renderWithProviders(<DeletePostDialog />, { store });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.post_delete_submit() }));

    // A post is cached in three structurally different shapes at once (see
    // `lib/post-cache.ts`); missing one leaves a stale live copy on screen.
    // Asserted against that module's own inventory rather than a second copy
    // of the list, so a cache added there is a failure here until it is swept.
    await waitFor(() => {
      for (const queryKey of POST_CACHE_KEYS) {
        expect(invalidate).toHaveBeenCalledWith({ queryKey });
      }
    });
    expect(invalidate).toHaveBeenCalledTimes(POST_CACHE_KEYS.length);
  });

  it("stays open with an error when the delete fails — the card behind it still shows the post", async () => {
    fakeClient.post.delete.mockRejectedValue(new Error("nope"));
    const store = createStore();
    store.set(deletePostDialogAtom, "post-1");
    await renderWithProviders(<DeletePostDialog />, { store });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.post_delete_submit() }));

    expect(await screen.findByRole("alert")).toHaveTextContent(m.post_delete_error());
    expect(store.get(deletePostDialogAtom)).toBe("post-1");
  });
});
