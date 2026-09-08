import { useAtomValue } from "jotai";
import {
  reportDialogAtom,
  blockDialogAtom,
  deletePostDialogAtom,
  editPostDialogAtom,
  quoteDialogAtom,
} from "@/atoms/dialog-targets";
import { shareDialogAtom } from "@/atoms/share-dialog";
import { lazy, Suspense, useState, type ReactNode, type ComponentType } from "react";

const ReportDialog = lazy(() =>
  import("@/components/moderation/report-dialog").then((mod) => ({ default: mod.ReportDialog })),
);
const BlockDialog = lazy(() =>
  import("@/components/moderation/block-dialog").then((mod) => ({ default: mod.BlockDialog })),
);
const DeletePostDialog = lazy(() =>
  import("@/components/delete-post-dialog").then((mod) => ({ default: mod.DeletePostDialog })),
);
const EditPostDialog = lazy(() =>
  import("@/components/edit-post-dialog").then((mod) => ({ default: mod.EditPostDialog })),
);
const QuoteDialog = lazy(() =>
  import("@/components/quote-dialog").then((mod) => ({ default: mod.QuoteDialog })),
);
const ShareDialog = lazy(() =>
  import("@/components/share-dialog").then((mod) => ({ default: mod.ShareDialog })),
);

const defaultDialogs = {
  ReportDialog,
  BlockDialog,
  DeletePostDialog,
  EditPostDialog,
  QuoteDialog,
  ShareDialog,
};

/** One instance per global dialog, loaded only when its shared target is requested. */
export function GlobalDialogs({
  dialogs = defaultDialogs,
}: {
  dialogs?: { [Name in keyof typeof defaultDialogs]: ComponentType };
}) {
  const { ReportDialog, BlockDialog, DeletePostDialog, EditPostDialog, QuoteDialog, ShareDialog } =
    dialogs;
  const report = useAtomValue(reportDialogAtom);
  const block = useAtomValue(blockDialogAtom);
  const deletePost = useAtomValue(deletePostDialogAtom);
  const editPost = useAtomValue(editPostDialogAtom);
  const quote = useAtomValue(quoteDialogAtom);
  const share = useAtomValue(shareDialogAtom);

  return (
    <>
      <RequestedDialog requested={report !== null}>
        <ReportDialog />
      </RequestedDialog>
      <RequestedDialog requested={block !== null}>
        <BlockDialog />
      </RequestedDialog>
      <RequestedDialog requested={deletePost !== null}>
        <DeletePostDialog />
      </RequestedDialog>
      <RequestedDialog requested={editPost !== null}>
        <EditPostDialog />
      </RequestedDialog>
      <RequestedDialog requested={quote !== null}>
        <QuoteDialog />
      </RequestedDialog>
      <RequestedDialog requested={share !== null}>
        <ShareDialog />
      </RequestedDialog>
    </>
  );
}

function RequestedDialog({ requested, children }: { requested: boolean; children: ReactNode }) {
  const [hasRequested, setHasRequested] = useState(false);
  if (requested && !hasRequested) setHasRequested(true);

  // Keep the wrapper mounted after first use: its own closed-state render
  // owns focus restoration, exit behavior, and body/mutation cleanup. Each
  // boundary suspends independently so one slow import cannot hide another.
  return hasRequested ? <Suspense fallback={null}>{children}</Suspense> : null;
}
