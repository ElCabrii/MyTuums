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
 * kebab on any card and the profile menu open the same instance. Blocks close
 * immediately on click; a failed block surfaces its error on the next open
 * (the mutation atom keeps the error until the next attempt).
 */
export function BlockDialog() {
  const target = useAtomValue(blockDialogAtom);
  const setTarget = useSetAtom(blockDialogAtom);
  const block = useAtomValue(blockAtom);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) setTarget(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target ? m.moderation_block_title({ handle: target.handle }) : m.moderation_kebab()}
          </DialogTitle>
          <DialogDescription>{target ? m.moderation_block_body() : ""}</DialogDescription>
        </DialogHeader>
        {target && (
          <div className="px-6 pb-6">
            {block.isError && (
              <p role="alert" className="text-xs text-destructive mb-2">
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
        )}
      </DialogContent>
    </Dialog>
  );
}
