import { useAtomValue, useSetAtom } from "jotai";
import { Copy } from "lucide-react";
import type { Post } from "@/lib/orpc";
import { ProfileLink } from "@/components/profile-link";
import { LinkedText } from "@/components/linked-text";
import { PostAttachmentGrid } from "@/components/post-attachment-grid";
import { shareDialogAtom } from "@/atoms/share-dialog";
import { copyPostLink, postPermalinkUrl } from "@/lib/share";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The app-wide share dialog (issue #307), one instance mounted at the root —
 * the same identity-atom shape as `QuoteDialog`: any card's Share button only
 * sets the target, so two buttons cannot stack two dialogs.
 *
 * The URL is the post's canonical permalink — the one public URL surface, so
 * a shared link works for readers without an account.
 */
export function ShareDialog() {
  const post = useAtomValue(shareDialogAtom);
  const setPost = useSetAtom(shareDialogAtom);

  return (
    <Dialog
      open={post !== null}
      onOpenChange={(next) => {
        if (!next) setPost(null);
      }}
    >
      {post !== null && <ShareDialogBody post={post} />}
    </Dialog>
  );
}

function ShareDialogBody({ post }: { post: Post }) {
  const authorHandle = handleOf(post.author);
  const authorName = post.author.name || authorHandle || m.user_unknown();
  const url = postPermalinkUrl(post.id);

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{m.post_share_dialog_title()}</DialogTitle>
        <DialogDescription>{m.post_share_dialog_description()}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3 px-6 pb-6">
        {/* The post being shared, previewed as the reader will land on it:
            author line, words, images. The dialog only opens from a live
            card's action bar, so there is no tombstone shape to degrade to. */}
        <div className="border-border bg-muted/20 rounded-lg border p-3">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {authorHandle ? (
              <ProfileLink
                username={authorHandle}
                className="flex items-center gap-1.5 hover:underline"
              >
                <span className="text-foreground truncate text-sm font-bold">{authorName}</span>
                <span className="text-muted-foreground text-xs">@{authorHandle}</span>
              </ProfileLink>
            ) : (
              <span className="text-foreground truncate text-sm font-bold">{authorName}</span>
            )}
          </div>
          {post.content && (
            <p className="text-foreground/90 text-sm leading-relaxed break-words whitespace-pre-line">
              <LinkedText text={post.content} />
            </p>
          )}
          <PostAttachmentGrid attachments={post.attachments} />
        </div>

        {/* The link itself: selectable in full with one click (`select-all`,
            the same affordance the TOTP secret uses) for the hand-copy path,
            and one button for the clipboard. The toast — success or failure —
            is the copy's confirmation; the dialog stays open so the user can
            read the URL or copy again. */}
        <p className="bg-muted/40 rounded-lg p-3 font-mono text-xs break-all select-all">{url}</p>
        <Button
          type="button"
          variant="outline"
          className="w-full gap-2 rounded-full"
          onClick={() => void copyPostLink(post.id)}
        >
          <Copy className="h-4 w-4" />
          {m.post_share_copy_link()}
        </Button>
      </div>
    </DialogContent>
  );
}
