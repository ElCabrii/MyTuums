import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { Post } from "@/lib/orpc";
import { ComposerForm } from "@/components/composer-form";
import { ProfileLink } from "@/components/profile-link";
import { LinkedText } from "@/components/linked-text";
import { PostAttachmentGrid } from "@/components/post-attachment-grid";
import {
  createQuoteAtom,
  quoteAttachmentsAtom,
  quoteDialogAtom,
  quoteDraftAtom,
} from "@/atoms/quote-composer";
import { viewerAtom } from "@/atoms/session";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The app-wide quote composer (issue #261), one dialog mounted at the root —
 * the same identity-atom shape as `DeletePostDialog`: any card's Quote button
 * only sets the target, so two buttons cannot stack two dialogs.
 *
 * The body is mounted only while a target is set, so the mutation atom (and
 * its error state) resets when the dialog closes.
 */
export function QuoteDialog() {
  const quoted = useAtomValue(quoteDialogAtom);
  const setQuoted = useSetAtom(quoteDialogAtom);
  const setDraft = useSetAtom(quoteDraftAtom);
  const setAttachments = useSetAtom(quoteAttachmentsAtom);

  return (
    <Dialog
      open={quoted !== null}
      onOpenChange={(next) => {
        if (!next) {
          // Cancel means discard this quote attempt. Success resets the same
          // atoms in `createQuoteAtom`; resetting here prevents a canceled
          // draft or its selected files appearing against a different post.
          setDraft("");
          setAttachments([]);
          setQuoted(null);
        }
      }}
    >
      {quoted !== null && <QuoteDialogBody quoted={quoted} />}
    </Dialog>
  );
}

function QuoteDialogBody({ quoted }: { quoted: Post }) {
  const user = useAtomValue(viewerAtom);
  const [content, setContent] = useAtom(quoteDraftAtom);
  const [attachments, setAttachments] = useAtom(quoteAttachmentsAtom);
  const createQuote = useAtomValue(createQuoteAtom);

  if (!user) return null;

  const quotedHandle = handleOf(quoted.author);
  const quotedName = quoted.author.name || quotedHandle || m.user_unknown();

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{m.quote_dialog_title()}</DialogTitle>
        <DialogDescription>{m.quote_dialog_description()}</DialogDescription>
      </DialogHeader>
      <div className="px-6 pb-6">
        {/* The post being quoted, previewed as it will embed: the same card
            the feed renders inside the quote. Tombstoned originals stay
            quotable (removal is not invisibility), so preview what they are
            now — a stub — rather than what they were. */}
        {quoted.removed || quoted.deleted ? (
          <div className="border-border/60 bg-muted/30 mb-3 rounded-lg border p-3">
            <p className="text-muted-foreground text-sm">
              {quoted.removed ? m.moderation_post_removed_stub() : m.post_deleted_stub()}
            </p>
            {quoted.removedReason && (
              <p className="text-foreground/80 mt-1 text-sm">
                {m.moderation_post_removed_reason({ reason: quoted.removedReason })}
              </p>
            )}
          </div>
        ) : (
          <div className="border-border bg-muted/20 mb-3 rounded-lg border p-3">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              {quotedHandle ? (
                <ProfileLink
                  username={quotedHandle}
                  className="flex items-center gap-1.5 hover:underline"
                >
                  <span className="text-foreground truncate text-sm font-bold">{quotedName}</span>
                  <span className="text-muted-foreground text-xs">@{quotedHandle}</span>
                </ProfileLink>
              ) : (
                <span className="text-foreground truncate text-sm font-bold">{quotedName}</span>
              )}
            </div>
            {quoted.content && (
              <p className="text-foreground/90 text-sm leading-relaxed break-words whitespace-pre-line">
                <LinkedText text={quoted.content} />
              </p>
            )}
            <PostAttachmentGrid attachments={quoted.attachments} />
          </div>
        )}

        <ComposerForm
          author={user}
          value={content}
          onValueChange={setContent}
          onSubmit={(body, selectedAttachments) => {
            createQuote.mutate({
              content: body,
              quotedPostId: quoted.id,
              attachments: selectedAttachments?.map(({ file }) => file) ?? [],
            });
          }}
          isPending={createQuote.isPending}
          errorMessage={
            createQuote.isError ? createQuote.error.message || m.quote_publish_error() : null
          }
          placeholder={m.quote_placeholder()}
          submitLabel={m.quote_action()}
          mentionScope="quote-composer"
          attachments={attachments}
          onAttachmentsChange={setAttachments}
        />
      </div>
    </DialogContent>
  );
}
