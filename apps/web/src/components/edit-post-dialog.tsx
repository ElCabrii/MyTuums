import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { editPostAtom, editPostDialogAtom, type EditPostTarget } from "@/atoms/post-edit";
import { ComposerForm } from "@/components/composer-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { localizeEditPostError } from "@/lib/edit-post-error";
import { viewerAtom } from "@/atoms/session";
import { m } from "@/paraglide/messages.js";

/**
 * The text editor for the viewer's own post, one dialog app-wide — built like
 * `DeletePostDialog`: mounted at the root layout and bound to the shared
 * `editPostDialogAtom`, so the kebab on any card opens the same instance.
 *
 * v1 is text-only (issue #264): the composer here sends no attachments and
 * the ones the post already has are untouched — `post.edit` rewrites `content`
 * and nothing else, so the images ride along unchanged.
 *
 * The body lives in `EditPostDialogBody`, mounted only while a target is set:
 * the mutation atom is read there, so closing the dialog unmounts its last
 * subscriber and the mutation observer resets — a failed edit's error never
 * surfaces on the next open, for a different post. The draft state resets the
 * same way, because it lives in the body.
 */
export function EditPostDialog() {
  const target = useAtomValue(editPostDialogAtom);
  const setTarget = useSetAtom(editPostDialogAtom);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) setTarget(null);
      }}
    >
      {target !== null && <EditPostDialogBody target={target} />}
    </Dialog>
  );
}

/** The editing half of the dialog — mounted only while a target is set. */
function EditPostDialogBody({ target }: { target: EditPostTarget }) {
  const setTarget = useSetAtom(editPostDialogAtom);
  const editPost = useAtomValue(editPostAtom);
  const viewer = useAtomValue(viewerAtom);
  // Seeded once per target from the snapshot the card handed the atom — the
  // text the viewer was just looking at, never a cache hunt that can miss.
  const [draft, setDraft] = useState(target.content);

  // Closing on success, like `DeletePostDialog`: a failed save has to leave
  // the dialog standing with the error, because the card behind it still
  // shows the old text and nothing else would say the edit did not happen.
  useEffect(() => {
    if (editPost.isSuccess) setTarget(null);
  }, [editPost.isSuccess, setTarget]);

  if (!viewer) return null;

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{m.post_edit_title()}</DialogTitle>
        <DialogDescription>{m.post_edit_body()}</DialogDescription>
      </DialogHeader>
      {/* The composer chrome rather than a bare textarea: the character
          counter, the length rule and the mention highlighting are the ones
          every other editor in the app uses, and they must not differ here.
          No `onAttachmentsChange` — v1 edits text only, so the image picker
          stays out and the existing attachments are not offered for removal.
          `existingAttachmentCount` is what lets the text be saved down to
          empty on a post that carries images — the same cross-field rule
          `post.edit` enforces against the row's own attachments. */}
      <div className="px-6 pb-6">
        <ComposerForm
          author={viewer}
          value={draft}
          onValueChange={setDraft}
          onSubmit={(content) => {
            editPost.mutate({ postId: target.postId, content });
          }}
          isPending={editPost.isPending}
          // The server's own refusal, not the generic one: every refusal
          // `post.edit` makes has a distinct reason, and the dialog is the only
          // place it can be said. The two state refusals map to translated
          // copy through `localizeEditPostError`; anything else (including a
          // message-less transport error) falls through verbatim or to the
          // generic string.
          errorMessage={
            editPost.isError
              ? localizeEditPostError(editPost.error.message) || m.post_edit_error()
              : null
          }
          placeholder={m.post_edit_placeholder()}
          submitLabel={m.post_edit_submit()}
          mentionScope="edit-post"
          rows={4}
          existingAttachmentCount={target.attachmentCount}
        />
      </div>
    </DialogContent>
  );
}
