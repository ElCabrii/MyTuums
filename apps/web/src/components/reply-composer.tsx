import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { ComposerForm } from "@/components/composer-form";
import { createReplyAtomFamily, replyDraftAtomFamily } from "@/atoms/reply-composer";
import { viewerAtom } from "@/atoms/session";
import { m } from "@/paraglide/messages.js";

/**
 * The thread page's reply box — a `ComposerForm` bound to the per-parent reply
 * draft and mutation atoms, with a "Replying to @x" header.
 */
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
        createReply.isError ? createReply.error.message || m.reply_publish_error() : null
      }
      placeholder={m.reply_placeholder()}
      submitLabel={m.reply_action()}
      header={
        replyingTo ? (
          <p className="text-muted-foreground text-xs">
            {m.reply_replying_to()}{" "}
            <Link
              to="/@{$username}"
              params={{ username: replyingTo }}
              className="text-link font-medium hover:underline"
            >
              @{replyingTo}
            </Link>
          </p>
        ) : undefined
      }
    />
  );
}
