import { useAtom, useAtomValue } from "jotai";
import { Globe, Lock } from "lucide-react";
import { PendingVideos } from "@/components/pending-videos";
import { ComposerForm } from "@/components/composer-form";
import {
  composerAttachmentsAtom,
  composerDraftAtom,
  composerPrivacyAtom,
  createPostAtom,
} from "@/atoms/composer";
import { viewerAtom } from "@/atoms/session";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { m } from "@/paraglide/messages.js";

/**
 * The composer on the home feed and one's own profile — a `ComposerForm` bound
 * to the shared draft and mutation. Only top-level posts expose an audience
 * choice; private accounts always use followers-only, even with a draft override.
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
  const effectivePrivate = accountDefault || (isPrivate ?? false);
  const audience = effectivePrivate ? m.composer_private_label() : m.composer_public_label();

  return (
    <div className="space-y-4">
      <ComposerForm
        author={user}
        value={content}
        onValueChange={setContent}
        onSubmit={(body, selectedAttachments, video) => {
          createPost.mutate({
            content: body,
            attachments: selectedAttachments?.map(({ file }) => file) ?? [],
            isPrivate: effectivePrivate,
            ...video,
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
        toolbarExtra={
          <Popover>
            <PopoverTrigger
              render={<Button variant="outline" size="sm" />}
              type="button"
              disabled={createPost.isPending}
              aria-label={m.composer_visibility_trigger({ audience })}
              title={m.composer_visibility_trigger({ audience })}
              className="text-muted-foreground h-8 gap-1.5 rounded-full px-3"
            >
              {effectivePrivate ? <Lock aria-hidden="true" /> : <Globe aria-hidden="true" />}
              <span className="hidden sm:inline">{audience}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="max-w-[calc(100vw-2rem)]">
              <PopoverTitle>{m.composer_visibility_label()}</PopoverTitle>
              <PopoverDescription>
                {accountDefault ? m.composer_private_account_default() : m.composer_private_hint()}
              </PopoverDescription>
              <RadioGroup
                aria-label={m.composer_visibility_label()}
                value={effectivePrivate ? "private" : "public"}
                disabled={createPost.isPending}
                onValueChange={(value) => {
                  if (!createPost.isPending && !accountDefault) setIsPrivate(value === "private");
                }}
              >
                <label className="flex items-center gap-3 py-1 has-data-disabled:opacity-50">
                  <RadioGroupItem value="public" disabled={accountDefault} />
                  {m.composer_public_label()}
                </label>
                <label className="flex items-center gap-3 py-1">
                  <RadioGroupItem value="private" />
                  {m.composer_private_label()}
                </label>
              </RadioGroup>
            </PopoverContent>
          </Popover>
        }
      />
      <PendingVideos />
    </div>
  );
}
