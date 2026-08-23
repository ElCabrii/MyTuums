import { useAtom, useAtomValue } from "jotai";
import { ComposerForm } from "@/components/composer-form";
import { composerAttachmentsAtom, composerDraftAtom, createPostAtom } from "@/atoms/composer";
import { viewerAtom } from "@/atoms/session";
import { m } from "@/paraglide/messages.js";

/**
 * The composer on the home feed and one's own profile — a `ComposerForm` bound
 * to `composerDraftAtom` and `createPostAtom`.
 */
export function PostComposer() {
  const user = useAtomValue(viewerAtom);
  const [content, setContent] = useAtom(composerDraftAtom);
  const [attachments, setAttachments] = useAtom(composerAttachmentsAtom);
  const createPost = useAtomValue(createPostAtom);

  if (!user) return null;

  return (
    <ComposerForm
      author={user}
      value={content}
      onValueChange={setContent}
      onSubmit={(body, selectedAttachments) => {
        createPost.mutate({
          content: body,
          attachments: selectedAttachments?.map(({ file }) => file) ?? [],
        });
      }}
      isPending={createPost.isPending}
      errorMessage={createPost.isError ? createPost.error.message || m.post_publish_error() : null}
      placeholder={m.post_placeholder()}
      submitLabel={m.post_action()}
      mentionScope="post"
      attachments={attachments}
      onAttachmentsChange={setAttachments}
    />
  );
}
