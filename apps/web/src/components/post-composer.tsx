import { useAtom, useAtomValue } from "jotai";
import { Lock } from "lucide-react";
import { ComposerForm } from "@/components/composer-form";
import {
  composerAttachmentsAtom,
  composerDraftAtom,
  composerPrivacyAtom,
  createPostAtom,
} from "@/atoms/composer";
import { viewerAtom } from "@/atoms/session";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages.js";

/**
 * The composer on the home feed and one's own profile — a `ComposerForm` bound
 * to `composerDraftAtom` and `createPostAtom`, plus the followers-only toggle
 * (issue #328) rendered *inside* the form via `footerExtra`. The toggle
 * defaults from the account's `isPrivate` — private accounts post private by
 * default — and can be flipped per post for public accounts. A private
 * account's posts are always followers-only, so its toggle is locked on with
 * an explanatory note rather than offering an off state that changes nothing.
 */
export function PostComposer() {
  const user = useAtomValue(viewerAtom);
  const [content, setContent] = useAtom(composerDraftAtom);
  const [attachments, setAttachments] = useAtom(composerAttachmentsAtom);
  const createPost = useAtomValue(createPostAtom);
  // In-memory, cleared on publish: null follows the account default, and
  // flipping it affects only the post it was flipped for.
  const [isPrivate, setIsPrivate] = useAtom(composerPrivacyAtom);

  if (!user) return null;

  const accountDefault = user.isPrivate ?? false;
  const effectivePrivate = isPrivate ?? accountDefault;

  return (
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
      errorMessage={createPost.isError ? createPost.error.message || m.post_publish_error() : null}
      placeholder={m.post_placeholder()}
      submitLabel={m.post_action()}
      mentionScope="post"
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      footerExtra={
        <div className="border-border/60 rounded-lg border border-dashed px-3 py-2">
          <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
            <Switch
              checked={accountDefault ? true : effectivePrivate}
              disabled={createPost.isPending || accountDefault}
              aria-label={m.composer_private_label()}
              onCheckedChange={setIsPrivate}
            />
            <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="font-medium">{m.composer_private_label()}</span>
          </label>
          <p className="text-muted-foreground mt-1 pl-8 text-xs">
            {accountDefault ? m.composer_private_account_default() : m.composer_private_hint()}
          </p>
        </div>
      }
    />
  );
}
