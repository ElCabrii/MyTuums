import { lazy, type ComponentType } from "react";
import { ShareDialog } from "@/components/share-dialog";
import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { GlobalDialogs } from "@/components/global-dialogs";
import { shareDialogAtom } from "@/atoms/share-dialog";
import {
  reportDialogAtom,
  blockDialogAtom,
  deletePostDialogAtom,
  editPostDialogAtom,
  quoteDialogAtom,
} from "@/atoms/dialog-targets";
import { makePost } from "@/test/factories";

it("#355 loads no global dialog at startup and opens only the requested dialog", async () => {
  const loaded = new Set<string>();
  let resolveShare!: () => void;
  const shareModule = new Promise<void>((resolve) => {
    resolveShare = resolve;
  });
  function deferredDialog(name: string, Component: ComponentType = () => null) {
    return lazy(async () => {
      loaded.add(name);
      if (name === "share") await shareModule;
      return { default: Component };
    });
  }
  const dialogs = {
    ReportDialog: deferredDialog("report"),
    BlockDialog: deferredDialog("block"),
    DeletePostDialog: deferredDialog("delete"),
    EditPostDialog: deferredDialog("edit"),
    QuoteDialog: deferredDialog("quote"),
    ShareDialog: deferredDialog("share", ShareDialog),
  };
  const { store } = await renderWithProviders(<GlobalDialogs dialogs={dialogs} />);
  expect([...loaded]).toEqual([]);

  act(() => {
    store.set(shareDialogAtom, makePost({ content: "The first requested post" }));
  });
  await waitFor(() => expect([...loaded]).toEqual(["share"]));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // A slow first import must read the current target, not capture the first click.
  await act(async () => {
    store.set(shareDialogAtom, makePost({ content: "The current requested post" }));
    resolveShare();
    await shareModule;
  });
  expect(await screen.findByText("The current requested post")).toBeInTheDocument();
  expect([...loaded]).toEqual(["share"]);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);

  act(() => {
    store.set(shareDialogAtom, null);
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  act(() => {
    store.set(shareDialogAtom, makePost({ content: "Reopened target" }));
  });
  expect(await screen.findByText("Reopened target")).toBeInTheDocument();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);

  // Other loaders remain independent of Share and of each other.
  act(() => {
    store.set(reportDialogAtom, { targetType: "user", targetId: "reported" });
  });
  await waitFor(() => expect([...loaded]).toEqual(["share", "report"]));
  act(() => {
    store.set(blockDialogAtom, { userId: "blocked", handle: "blocked" });
  });
  await waitFor(() => expect([...loaded]).toEqual(["share", "report", "block"]));
  act(() => {
    store.set(deletePostDialogAtom, "deleted");
  });
  await waitFor(() => expect([...loaded]).toEqual(["share", "report", "block", "delete"]));
  act(() => {
    store.set(editPostDialogAtom, { postId: "edited", content: "Draft", attachmentCount: 0 });
  });
  await waitFor(() => expect([...loaded]).toEqual(["share", "report", "block", "delete", "edit"]));
  act(() => {
    store.set(quoteDialogAtom, makePost());
  });
  await waitFor(() =>
    expect([...loaded]).toEqual(["share", "report", "block", "delete", "edit", "quote"]),
  );
});
