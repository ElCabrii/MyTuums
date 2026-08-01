import { useAtom, useAtomValue } from "jotai";
import { ComposerForm } from "@/components/composer-form";
import { createReplyAtomFamily, replyDraftAtomFamily } from "@/atoms/reply-composer";
import { viewerAtom } from "@/atoms/session";

export function ReplyComposer({
  parentId,
  replyingTo,
}: {
  parentId: string;
  /** The handle being replied to, for the line above the box. Null if the author has none. */
  replyingTo: string | null;
}) {
  const user = useAtomValue(viewerAtom);
  const [content, setContent] = useAtom(replyDraftAtomFamily(parentId));
  const createReply = useAtomValue(createReplyAtomFamily(parentId));

  if (!user) return null;

  return (
    <ComposerForm
      author={user}
      value={content}
      onValueChange={setContent}
      onSubmit={(body) => {
        createReply.mutate({ content: body, parentId });
      }}
      isPending={createReply.isPending}
      errorMessage={
        createReply.isError
          ? createReply.error.message || "Could not publish your reply. Please try again."
          : null
      }
      placeholder="Post your reply..."
      submitLabel="Reply"
      header={
        replyingTo ? (
          <p className="text-xs text-muted-foreground">
            Replying to <span className="text-primary">@{replyingTo}</span>
          </p>
        ) : undefined
      }
    />
  );
}
