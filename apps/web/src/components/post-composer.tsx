import { useAtom, useAtomValue } from "jotai";
import { useState } from "react";
import { Lock } from "lucide-react";
import { ComposerForm } from "@/components/composer-form";
import { composerAttachmentsAtom, composerDraftAtom, createPostAtom } from "@/atoms/composer";
import { viewerAtom } from "@/atoms/session";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages.js";

/**
 * The composer on the home feed and one's own profile — a `ComposerForm` bound
 * to `composerDraftAtom` and `createPostAtom`, plus the followers-only toggle
 * (issue #328). The toggle defaults from the account's `isPrivate` — private
 * accounts post private by default — and can be flipped per post.
 */
export function PostComposer() {
  const user = useAtomValue(viewerAtom);
  const [content, setContent] = useAtom(composerDraftAtom);
  const [attachments, setAttachments] = useAtom(composerAttachmentsAtom);
  const createPost = useAtomValue(createPostAtom);
  // Local, not persisted: one dialog, bounded lifetime, nothing to evict.
  // Defaults from the account on mount; flipping it affects only this post.
  const [isPrivate, setIsPrivate] = useState<boolean | null>(null);

  if (!user) return null;

  const accountDefault = user.isPrivate ?? false;
  const effectivePrivate = isPrivate ?? accountDefault;

  return (
    <div className="space-y-2">
      <ComposerForm
        author={user}
        value={content}
        onValueChange={setContent}
        onSubmit={(body, selectedAttachments) => {
          createPost.mutate({
            content: body,
            attachments: selectedAttachments?.map(({ file }) => file) ?? [],
            isPrivate: effectivePrivate,
          });
        }}
        isPending={createPost.isPending}
        errorMessage={
          createPost.isError ? createPost.error.message || m.post_publish_error() : null
        }
        placeholder={m.post_placeholder()}
        submitLabel={m.post_action()}
        mentionScope="post"
        attachments={attachments}
        onAttachmentsChange={setAttachments}
      />
      <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
        <Switch
          checked={effectivePrivate}
          disabled={createPost.isPending}
          aria-label={m.composer_private_label()}
          onCheckedChange={setIsPrivate}
        />
        <Lock className="h-3 w-3" aria-hidden="true" />
        <span>{m.composer_private_label()}</span>
      </label>
    </div>
  );
}
