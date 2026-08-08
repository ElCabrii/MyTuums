import { useAtomValue, useSetAtom } from "jotai";
import { blockAtom, blockDialogAtom } from "@/atoms/moderation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { m } from "@/paraglide/messages.js";

/**
 * The block confirmation, one dialog app-wide — the mirror of `ReportDialog`:
 * mounted at the root layout and bound to the shared `blockDialogAtom`, so the
 * kebab on any card and the profile menu open the same instance.
 *
 * The body lives in `BlockDialogBody`, mounted only while a target is set:
 * the mutation atom is read there, so closing the dialog unmounts its last
 * subscriber and the mutation observer resets — a failed block's error never
 * surfaces on the next open, for a possibly different user.
 */
export function BlockDialog() {
  const target = useAtomValue(blockDialogAtom);
  const setTarget = useSetAtom(blockDialogAtom);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) setTarget(null);
      }}
    >
      {target && <BlockDialogBody target={target} />}
    </Dialog>
  );
}

/** The confirmation half of the block dialog — mounted only while a target is set. */
function BlockDialogBody({ target }: { target: { userId: string; handle: string } }) {
  const setTarget = useSetAtom(blockDialogAtom);
  const block = useAtomValue(blockAtom);

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{m.moderation_block_title({ handle: target.handle })}</DialogTitle>
        <DialogDescription>{m.moderation_block_body()}</DialogDescription>
      </DialogHeader>
      <div className="px-6 pb-6">
        {block.isError && (
          <p role="alert" className="text-destructive mb-2 text-xs">
            {m.moderation_block_error()}
          </p>
        )}
        <Button
          variant="destructive"
          className="w-full"
          disabled={block.isPending}
          onClick={() => {
            block.mutate({ userId: target.userId });
            setTarget(null);
          }}
        >
          {m.moderation_block_submit()}
        </Button>
      </div>
    </DialogContent>
  );
}
