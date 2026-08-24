import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { deletePostAtom, deletePostDialogAtom } from "@/atoms/post-delete";
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
 * The delete confirmation for the viewer's own post, one dialog app-wide —
 * built like `BlockDialog`: mounted at the root layout and bound to the shared
 * `deletePostDialogAtom`, so the kebab on any card opens the same instance.
 *
 * The body lives in `DeletePostDialogBody`, mounted only while a target is
 * set: the mutation atom is read there, so closing the dialog unmounts its
 * last subscriber and the mutation observer resets — a failed delete's error
 * never surfaces on the next open, for a different post.
 */
export function DeletePostDialog() {
  const postId = useAtomValue(deletePostDialogAtom);
  const setPostId = useSetAtom(deletePostDialogAtom);

  return (
    <Dialog
      open={postId !== null}
      onOpenChange={(next) => {
        if (!next) setPostId(null);
      }}
    >
      {postId !== null && <DeletePostDialogBody postId={postId} />}
    </Dialog>
  );
}

/** The confirmation half of the delete dialog — mounted only while a target is set. */
function DeletePostDialogBody({ postId }: { postId: string }) {
  const setPostId = useSetAtom(deletePostDialogAtom);
  const deletePost = useAtomValue(deletePostAtom);

  // Closing on success rather than on click, unlike `BlockDialog`: a delete
  // that fails has to leave its dialog standing with the error, because the
  // card behind it still shows the post and nothing else would say the delete
  // did not happen. The success path is what dismisses it.
  useEffect(() => {
    if (deletePost.isSuccess) setPostId(null);
  }, [deletePost.isSuccess, setPostId]);

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{m.post_delete_title()}</DialogTitle>
        <DialogDescription>{m.post_delete_body()}</DialogDescription>
      </DialogHeader>
      <div className="px-6 pb-6">
        {deletePost.isError && (
          <p role="alert" className="text-destructive mb-2 text-xs">
            {m.post_delete_error()}
          </p>
        )}
        <Button
          variant="destructive"
          className="w-full"
          disabled={deletePost.isPending}
          onClick={() => {
            deletePost.mutate({ postId });
          }}
        >
          {m.post_delete_submit()}
        </Button>
      </div>
    </DialogContent>
  );
}
