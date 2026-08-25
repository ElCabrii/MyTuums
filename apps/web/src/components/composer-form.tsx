import { useAtom, useAtomValue } from "jotai";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
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
import { composerMentionAtomFamily } from "@/atoms/composer-mentions";
import { typeaheadQueryAtomFamily } from "@/atoms/search";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { insertMention, mentionAtCaret } from "@/lib/composer-mentions";
import { nextHighlight, suggestionRows, type SuggestionRow } from "@/lib/search-suggestions";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

const MAX_COMPOSER_HEIGHT = 256;

function mentionUsers(rows: SuggestionRow[]): Extract<SuggestionRow, { kind: "user" }>[] {
  return rows.filter(
    (row): row is Extract<SuggestionRow, { kind: "user" }> =>
      row.kind === "user" && handleOf(row.user) !== null,
  );
}

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

function MentionSuggestions({
  rows,
  highlight,
  onHighlight,
  onAccept,
}: {
  rows: Extract<SuggestionRow, { kind: "user" }>[];
  highlight: number;
  onHighlight: (index: number) => void;
  onAccept: (index: number) => void;
}) {
  return (
    <div
      id="composer-mention-suggestions"
      role="listbox"
      aria-label={m.composer_mention_suggestions_aria()}
      className="border-border bg-popover text-popover-foreground absolute top-[calc(100%+0.5rem)] right-0 left-0 z-50 max-h-60 overflow-y-auto rounded-xl border p-1.5 shadow-lg"
    >
      {rows.map((row, index) => {
        const handle = handleOf(row.user);
        const displayName = row.user.name || handle || m.user_unknown();
        if (!handle) return null;

        return (
          <button
            key={row.user.id}
            type="button"
            role="option"
            aria-selected={index === highlight}
            id={`composer-mention-${index}`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHighlight(index)}
            onClick={() => onAccept(index)}
            className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left ${
              index === highlight ? "bg-muted/60" : ""
            }`}
          >
            <UserAvatar
              user={row.user}
              alt={displayName}
              className="h-8 w-8 shrink-0"
              fallbackClassName="text-xs font-bold bg-primary text-primary-foreground"
            />
            <span className="min-w-0">
              <span className="text-foreground block truncate text-sm font-medium">
                {displayName}
              </span>
              <span className="text-muted-foreground block truncate text-xs">@{handle}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
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
  mentionScope = "composer",
  attachments = [],
  onAttachmentsChange,
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
  /** Primitive key for transient mention state owned beside each draft atom. */
  mentionScope?: string;
  /** Optional image state; omitted only by callers that intentionally disable attachments. */
  attachments?: ComposerAttachment[];
  onAttachmentsChange?: (next: ComposerAttachment[]) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const suppressSelectionRef = useRef(false);
  const attachmentSelectionRef = useRef(0);
  const [mentionState, setMentionState] = useAtom(composerMentionAtomFamily(mentionScope));
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentsAreValidating, setAttachmentsAreValidating] = useState(false);
  const mentionQuery = mentionState.token?.query ?? "";
  const typeahead = useAtomValue(typeaheadQueryAtomFamily(mentionQuery));
  const trimmed = value.trim();
  const remaining = POST_MAX_LENGTH - value.length;
  const isTooLong = remaining < 0;
  // The same cross-field rule `post.create` enforces (issue #202): text,
  // images, or both — never neither. Attachment validation/pending state
  // still blocks until the selected files are known-good.
  const canSubmit =
    (trimmed.length > 0 || attachments.length > 0) &&
    !isTooLong &&
    !isPending &&
    !attachmentsAreValidating;
  const rowsForQuery = mentionUsers(suggestionRows(typeahead.data));
  const showMentionSuggestions =
    !isPending && mentionState.open && (typeahead.isPending || rowsForQuery.length > 0);
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

  useEffect(
    () => () => {
      setMentionState({ token: null, highlight: -1, open: false });
    },
    [setMentionState],
  );

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const height = Math.min(textarea.scrollHeight, MAX_COMPOSER_HEIGHT);
    if (height > 0) textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";

    const pendingCaret = pendingCaretRef.current;
    if (pendingCaret !== null) {
      textarea.focus();
      textarea.setSelectionRange(pendingCaret, pendingCaret);
      pendingCaretRef.current = null;
      // `suppressSelectionRef` stays armed on purpose: Chromium queues an
      // async `select` event for this programmatic caret move, and it fires
      // AFTER this effect returns — clearing the guard here let that echo
      // re-open the suggestion list over the just-accepted mention. A real
      // gesture (typing or clicking the textarea) disarms it instead; see
      // the onChange/onClick handlers.
    }
  }, [value]);

  const updateMentionState = (nextValue: string, start: number | null, end: number | null) => {
    if (suppressSelectionRef.current) return;
    const token = mentionAtCaret(nextValue, start, end);
    setMentionState((previous) => {
      const tokenIsUnchanged =
        token !== null &&
        previous.token !== null &&
        token.start === previous.token.start &&
        token.end === previous.token.end &&
        token.query === previous.token.query;

      // Chromium fires `select` after an ArrowDown/ArrowUp keydown even when
      // its default caret movement was prevented. Preserve the keyboard
      // highlight for that unchanged token; a real caret/token change still
      // starts navigation from no selection.
      if (tokenIsUnchanged) return { ...previous, open: true };
      return { token, highlight: -1, open: token !== null };
    });
  };

  const acceptMention = (index: number) => {
    const row = rowsForQuery[index];
    const token = mentionState.token;
    const handle = row ? handleOf(row.user) : null;
    if (!token || !handle) return;

    const insertion = insertMention(value, token, handle);
    // Both branches arm the selection guard and leave it armed: restoring the
    // caret queues a synthetic `select` that must not re-open the list. See
    // the layout effect above and the onChange/onClick handlers.
    if (insertion.value === value) {
      suppressSelectionRef.current = true;
      onValueChange(insertion.value);
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(insertion.caret, insertion.caret);
    } else {
      pendingCaretRef.current = insertion.caret;
      suppressSelectionRef.current = true;
      onValueChange(insertion.value);
    }
    setMentionState({ token: null, highlight: -1, open: false });
  };

  const handleMentionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showMentionSuggestions) {
      if (event.key === "Escape" && mentionState.open) {
        setMentionState((previous) => ({ ...previous, open: false, highlight: -1 }));
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setMentionState((previous) => ({
          ...previous,
          highlight: nextHighlight(previous.highlight, 1, rowsForQuery.length),
        }));
        break;
      case "ArrowUp":
        event.preventDefault();
        setMentionState((previous) => ({
          ...previous,
          highlight: nextHighlight(previous.highlight, -1, rowsForQuery.length),
        }));
        break;
      case "Enter":
      case "Tab":
        if (mentionState.highlight >= 0) {
          event.preventDefault();
          acceptMention(mentionState.highlight);
        }
        break;
      case "Escape":
        event.preventDefault();
        setMentionState((previous) => ({ ...previous, open: false, highlight: -1 }));
        break;
    }
  };

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

      if (
        next.length >= POST_ATTACHMENT_MAX_COUNT ||
        totalBytes + file.size > POST_ATTACHMENT_MAX_TOTAL_BYTES
      ) {
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

      next.push({ id: crypto.randomUUID(), file });
      totalBytes += file.size;
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
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            role="combobox"
            rows={rows}
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              // A real edit disarms the caret-restore guard before any
              // selection bookkeeping runs — the synthetic `select` echo the
              // guard exists for never follows a user keystroke.
              suppressSelectionRef.current = false;
              onValueChange(event.target.value);
              updateMentionState(
                event.target.value,
                event.target.selectionStart,
                event.target.selectionEnd,
              );
            }}
            onClick={(event) => {
              suppressSelectionRef.current = false;
              updateMentionState(
                event.currentTarget.value,
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
              );
            }}
            onSelect={(event) =>
              updateMentionState(
                event.currentTarget.value,
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
              )
            }
            onKeyDown={handleMentionKeyDown}
            aria-autocomplete="list"
            aria-expanded={showMentionSuggestions}
            aria-controls={showMentionSuggestions ? "composer-mention-suggestions" : undefined}
            aria-activedescendant={
              showMentionSuggestions && mentionState.highlight >= 0
                ? `composer-mention-${mentionState.highlight}`
                : undefined
            }
            disabled={isPending}
            className="placeholder:text-muted-foreground max-h-64 min-h-[3.5rem] w-full resize-none overflow-y-hidden border-none bg-transparent p-0 text-sm focus:ring-0 focus:outline-none disabled:opacity-60"
          />
          {showMentionSuggestions &&
            (typeahead.isPending ? (
              <div
                id="composer-mention-suggestions"
                role="listbox"
                aria-label={m.composer_mention_suggestions_aria()}
                className="border-border bg-popover text-popover-foreground absolute top-[calc(100%+0.5rem)] right-0 left-0 z-50 flex items-center justify-center rounded-xl border p-4 shadow-lg"
              >
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              </div>
            ) : (
              <MentionSuggestions
                rows={rowsForQuery}
                highlight={mentionState.highlight}
                onHighlight={(index) =>
                  setMentionState((previous) => ({ ...previous, highlight: index }))
                }
                onAccept={acceptMention}
              />
            ))}
        </div>
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
