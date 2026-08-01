import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { ComposerForm } from "@/components/composer-form";
import { createReplyAtomFamily, replyDraftAtomFamily } from "@/atoms/reply-composer";
import { viewerAtom } from "@/atoms/session";
import { m } from "@/paraglide/messages.js";

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
          ? createReply.error.message || m.reply_publish_error()
          : null
      }
      placeholder={m.reply_placeholder()}
      submitLabel={m.reply_action()}
      header={
        replyingTo ? (
          <p className="text-xs text-muted-foreground">
            {m.reply_replying_to()}{" "}
            <Link
              to="/@{$username}"
              params={{ username: replyingTo }}
              className="text-primary hover:underline font-medium"
            >
              @{replyingTo}
            </Link>
          </p>
        ) : undefined
      }
    />
  );
}
