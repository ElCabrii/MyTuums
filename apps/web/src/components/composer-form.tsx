import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, ImagePlus, Loader2, Send, X } from "lucide-react";
import {
  ALLOWED_IMAGE_TYPES,
  POST_ATTACHMENT_MAX_BYTES,
  POST_ATTACHMENT_MAX_COUNT,
  POST_ATTACHMENT_MAX_TOTAL_BYTES,
  POST_MAX_LENGTH,
} from "@my-tuums/api/constants";
import { acceptPostImage } from "@my-tuums/api/post-image";
import type { ComposerAttachment } from "@/atoms/composer";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { MentionTextarea } from "@/components/mention-textarea";
import { createPostAttachment } from "@/lib/media";
import { m } from "@/paraglide/messages.js";

/** Reads selected bytes through the browser's FileReader contract. */
function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error("Unable to read the selected image."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the selected image."));
    reader.readAsArrayBuffer(file);
  });
}

/** jsdom has no object-URL implementation; browsers do. */
function previewUrlFor(file: File): string {
  try {
    return URL.createObjectURL(file);
  } catch {
    return "";
  }
}

/**
 * The composer chrome — avatar, textarea, remaining-character counter, error
 * and submit — shared by the home composer and the thread page's reply box.
 *
 * It owns no state: the draft and the mutation both live in atoms, and which
 * atoms differ per caller (`composerDraftAtom` is one persisted draft, while
 * replies are an in-memory family keyed by parent). Passing them in keeps the
 * one thing that genuinely differs — where the text goes — at the call site,
 * and the length rule, which must not differ, here.
 *
 * `@handle` completion is delegated to `MentionTextarea`, the shared seam the
 * bio editor also mounts; `mentionScope` keeps each editor's transient
 * highlight state apart.
 */
export function ComposerForm({
  author,
  value,
  onValueChange,
  onSubmit,
  isPending,
  errorMessage,
  placeholder,
  submitLabel,
  rows = 2,
  header,
  footerExtra,
  mentionScope = "composer",
  attachments = [],
  onAttachmentsChange,
  existingAttachmentCount = 0,
}: {
  author: { name: string; image?: string | null };
  value: string;
  onValueChange: (next: string) => void;
  /** Called with the trimmed body, only when it is submittable. */
  onSubmit: (content: string, attachments?: ComposerAttachment[]) => void;
  isPending: boolean;
  /** Null when the last attempt didn't fail. */
  errorMessage: string | null;
  placeholder: string;
  submitLabel: string;
  rows?: number;
  /** Rendered above the textarea — the reply box's "Replying to @x" line. */
  header?: ReactNode;
  /** Rendered inside the form above the footer — e.g. the followers-only toggle. */
  footerExtra?: ReactNode;
  /** Primitive key for transient mention state owned beside each draft atom. */
  mentionScope?: string;
  /** Optional image state; omitted only by callers that intentionally disable attachments. */
  attachments?: ComposerAttachment[];
  onAttachmentsChange?: (next: ComposerAttachment[]) => void;
  /**
   * Images the submission rides on that this form cannot show or change —
   * the edit dialog's post already carries them. Their existence satisfies
   * the "text, images, or both" rule, so the caller may legally save an
   * empty text; zero (the default) keeps every other caller unchanged.
   */
  existingAttachmentCount?: number;
}) {
  const attachmentSelectionRef = useRef(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentsAreValidating, setAttachmentsAreValidating] = useState(false);
  const trimmed = value.trim();
  const remaining = POST_MAX_LENGTH - value.length;
  const isTooLong = remaining < 0;
  // The same cross-field rule `post.create` enforces (issue #202): text,
  // images, or both — never neither. "Images" counts the ones this form is
  // choosing plus the ones the target already carries
  // (`existingAttachmentCount`). Attachment validation/pending state still
  // blocks until the selected files are known-good.
  const canSubmit =
    (trimmed.length > 0 || attachments.length > 0 || existingAttachmentCount > 0) &&
    !isTooLong &&
    !isPending &&
    !attachmentsAreValidating;
  const previewUrls = useMemo(
    () =>
      attachments.map(({ id, file }) => ({
        id,
        url: previewUrlFor(file),
      })),
    [attachments],
  );

  useEffect(
    () => () => {
      for (const preview of previewUrls) {
        if (preview.url) URL.revokeObjectURL(preview.url);
      }
    },
    [previewUrls],
  );

  const updateAttachments = (next: ComposerAttachment[]) => {
    onAttachmentsChange?.(next);
    setAttachmentError(null);
  };

  const handleAttachmentSelection = async (files: FileList | null) => {
    if (!onAttachmentsChange || !files) return;
    const selectionId = attachmentSelectionRef.current + 1;
    attachmentSelectionRef.current = selectionId;
    setAttachmentError(null);
    setAttachmentsAreValidating(true);

    const selected = [...files];
    const next = [...attachments];
    let totalBytes = next.reduce((sum, attachment) => sum + attachment.file.size, 0);
    let nextError: string | null = null;

    for (const file of selected) {
      if (file.size <= 0 || file.size > POST_ATTACHMENT_MAX_BYTES) {
        nextError ??= m.post_image_invalid();
        continue;
      }

      if (next.length >= POST_ATTACHMENT_MAX_COUNT) {
        nextError = m.post_image_limit();
        break;
      }

      let accepted: boolean;
      try {
        const verdict = acceptPostImage(await readFileBytes(file), file.type);
        accepted = verdict.ok;
      } catch {
        accepted = false;
      }
      if (!accepted) {
        nextError ??= m.post_image_invalid();
        continue;
      }

      // What joins the draft is the re-encoded object, never the picked
      // bytes: processing strips EXIF/GPS metadata by construction and bounds
      // what an upload can weigh (lib/media.ts). A processing failure is the
      // same refusal as a byte-level one — the file simply never joins.
      let processed: File;
      try {
        processed = await createPostAttachment(file);
      } catch {
        nextError ??= m.post_image_invalid();
        continue;
      }

      // The batch budget counts what will actually be uploaded, so the cap
      // is measured against the processed objects — never the picked
      // originals. A re-encode can outweigh its source (a PNG fallback on a
      // browser without WebP encode), and the per-file cap above only bounds
      // the source; measuring here is what keeps a staged batch inside
      // POST_ATTACHMENT_MAX_TOTAL_BYTES, matching the server's own total.
      if (totalBytes + processed.size > POST_ATTACHMENT_MAX_TOTAL_BYTES) {
        nextError = m.post_image_limit();
        break;
      }

      next.push({ id: crypto.randomUUID(), file: processed });
      totalBytes += processed.size;
    }

    if (selectionId !== attachmentSelectionRef.current) return;
    if (nextError) setAttachmentError(nextError);
    if (next.length !== attachments.length) onAttachmentsChange(next);
    setAttachmentsAreValidating(false);
  };

  const moveAttachment = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= attachments.length) return;
    const next = [...attachments];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    updateAttachments(next);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        if (attachments.length > 0) onSubmit(trimmed, attachments);
        else onSubmit(trimmed);
      }}
      className="border-border bg-card space-y-3 rounded-xl border p-4 shadow-sm"
    >
      {header}

      <div className="flex gap-3">
        <UserAvatar
          user={author}
          className="bg-background h-10 w-10"
          fallbackClassName="bg-primary text-primary-foreground font-bold text-xs"
        />
        <MentionTextarea
          value={value}
          onValueChange={onValueChange}
          mentionScope={mentionScope}
          enableGameSuggestions
          placeholder={placeholder}
          rows={rows}
          disabled={isPending}
          wrapperClassName="min-w-0 flex-1"
          className="placeholder:text-muted-foreground max-h-64 min-h-[3.5rem] w-full resize-none rounded-none border-none bg-transparent p-0 text-sm focus-visible:ring-0 disabled:opacity-60"
        />
      </div>

      {/*
        Attachments surface only once there is something to show: before a
        selection the image affordance lives in the footer's action row (see
        below), and the size/count hint only matters while managing images.
      */}
      {onAttachmentsChange && attachments.length > 0 && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">{m.post_images_hint()}</p>
          <ol className="grid grid-cols-2 gap-2" aria-label={m.post_images_hint()}>
            {attachments.map((attachment, index) => {
              const preview = previewUrls.find(({ id }) => id === attachment.id);
              return (
                <li key={attachment.id} className="bg-muted/30 relative overflow-hidden rounded-lg">
                  {preview?.url ? (
                    <img
                      src={preview.url}
                      alt={attachment.file.name}
                      className="aspect-square w-full object-cover"
                    />
                  ) : (
                    <div className="text-muted-foreground flex aspect-square items-center justify-center p-2 text-center text-xs">
                      {attachment.file.name}
                    </div>
                  )}
                  <div className="absolute top-1 right-1 left-1 flex justify-between gap-1">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        aria-label={m.post_image_move_left({ name: attachment.file.name })}
                        title={m.post_image_move_left({ name: attachment.file.name })}
                        disabled={index === 0 || isPending || attachmentsAreValidating}
                        onClick={() => moveAttachment(index, -1)}
                        className="bg-background/90 text-foreground hover:bg-background rounded-full p-1 shadow disabled:opacity-40"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={m.post_image_move_right({ name: attachment.file.name })}
                        title={m.post_image_move_right({ name: attachment.file.name })}
                        disabled={
                          index === attachments.length - 1 || isPending || attachmentsAreValidating
                        }
                        onClick={() => moveAttachment(index, 1)}
                        className="bg-background/90 text-foreground hover:bg-background rounded-full p-1 shadow disabled:opacity-40"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <button
                      type="button"
                      aria-label={m.post_image_remove({ name: attachment.file.name })}
                      title={m.post_image_remove({ name: attachment.file.name })}
                      disabled={isPending || attachmentsAreValidating}
                      onClick={() =>
                        updateAttachments(attachments.filter(({ id }) => id !== attachment.id))
                      }
                      className="bg-background/90 text-foreground hover:bg-background rounded-full p-1 shadow disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {(attachmentError || errorMessage) && (
        <div
          role="alert"
          className="bg-destructive/10 border-destructive/20 text-destructive flex items-start gap-2 rounded-lg border p-2.5 text-xs"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{attachmentError || errorMessage}</span>
        </div>
      )}

      {footerExtra}

      <div className="border-border flex items-center justify-between gap-3 border-t pt-3">
        {/* The image picker rides the footer's action row like on every other
            platform: a pill button with a real hit target and focus ring,
            rather than the bare inline link this used to be. The hidden input
            stays inside the label so clicks and the accessible name keep
            working without JS wiring. */}
        {onAttachmentsChange && (
          <label className="border-border text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring focus-visible:ring-ring/50 inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors outline-none select-none focus-visible:ring-[3px] has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50">
            <ImagePlus className="h-4 w-4" />
            <span className="hidden sm:inline">{m.post_add_images()}</span>
            <input
              type="file"
              accept={ALLOWED_IMAGE_TYPES.join(",")}
              multiple
              className="sr-only"
              aria-label={m.post_add_images()}
              disabled={
                isPending ||
                attachmentsAreValidating ||
                attachments.length >= POST_ATTACHMENT_MAX_COUNT
              }
              onChange={(event) => {
                void handleAttachmentSelection(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
        )}
        <div className="flex items-center gap-3">
          <span
            aria-live="polite"
            className={`text-xs tabular-nums ${
              isTooLong
                ? "text-destructive font-semibold"
                : remaining <= 50
                  ? "text-foreground"
                  : "text-muted-foreground"
            }`}
          >
            {remaining}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
            className="gap-1.5 rounded-full px-4"
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            <span>{submitLabel}</span>
          </Button>
        </div>
      </div>
    </form>
  );
}
