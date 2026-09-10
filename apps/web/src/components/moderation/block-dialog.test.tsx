import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { blockDialogAtom } from "@/atoms/dialog-targets";

import { renderWithProviders } from "@/test/render";
import { BlockDialog } from "@/components/moderation/block-dialog";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = { moderation: { block: vi.fn() } };

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BlockDialog", () => {
  it("renders the target's handle in the confirmation copy and submits their id", async () => {
    fakeClient.moderation.block.mockResolvedValue({ userId: "user-1", blocked: true });
    const store = createStore();
    store.set(blockDialogAtom, { userId: "user-1", handle: "badactor" });
    await renderWithProviders(<BlockDialog />, { store });

    expect(
      await screen.findByRole("heading", {
        name: m.moderation_block_title({ handle: "badactor" }),
      }),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.moderation_block_submit() }));

    await waitFor(() =>
      expect(fakeClient.moderation.block).toHaveBeenCalledWith(
        { userId: "user-1" },
        expect.anything(),
      ),
    );
  });

  it("keeps a failed block visible and closes after a successful retry", async () => {
    fakeClient.moderation.block.mockRejectedValueOnce(new Error("Block failed"));
    fakeClient.moderation.block.mockResolvedValue({ userId: "user-1", blocked: true });
    const store = createStore();
    store.set(blockDialogAtom, { userId: "user-1", handle: "badactor" });
    await renderWithProviders(<BlockDialog />, { store });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.moderation_block_submit() }));

    expect(await screen.findByRole("alert")).toHaveTextContent(m.moderation_block_error());
    expect(store.get(blockDialogAtom)?.userId).toBe("user-1");
    await user.click(screen.getByRole("button", { name: m.moderation_block_submit() }));
    await waitFor(() => expect(store.get(blockDialogAtom)).toBeNull());
  });

  it("renders nothing for a different target after the dialog is retargeted", async () => {
    const store = createStore();
    store.set(blockDialogAtom, { userId: "user-1", handle: "alice" });
    await renderWithProviders(<BlockDialog />, { store });
    expect(screen.getByText(m.moderation_block_title({ handle: "alice" }))).toBeInTheDocument();

    act(() => store.set(blockDialogAtom, { userId: "user-2", handle: "bob" }));
    expect(
      await screen.findByText(m.moderation_block_title({ handle: "bob" })),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(m.moderation_block_title({ handle: "alice" })),
    ).not.toBeInTheDocument();
  });
});
