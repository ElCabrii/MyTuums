import type { ReactNode } from "react";
import { AlertCircle, Loader2, Send } from "lucide-react";
import { POST_MAX_LENGTH } from "@my-tuums/api/constants";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";

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
}: {
  author: { name: string; image?: string | null };
  value: string;
  onValueChange: (next: string) => void;
  /** Called with the trimmed body, only when it is submittable. */
  onSubmit: (content: string) => void;
  isPending: boolean;
  /** Null when the last attempt didn't fail. */
  errorMessage: string | null;
  placeholder: string;
  submitLabel: string;
  rows?: number;
  /** Rendered above the textarea — the reply box's "Replying to @x" line. */
  header?: ReactNode;
}) {
  const trimmed = value.trim();
  const remaining = POST_MAX_LENGTH - value.length;
  const isTooLong = remaining < 0;
  const canSubmit = trimmed.length > 0 && !isTooLong && !isPending;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        onSubmit(trimmed);
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
        <textarea
          rows={rows}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          disabled={isPending}
          className="placeholder:text-muted-foreground w-full resize-none border-none bg-transparent p-0 text-sm focus:ring-0 focus:outline-none disabled:opacity-60"
        />
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="bg-destructive/10 border-destructive/20 text-destructive flex items-start gap-2 rounded-lg border p-2.5 text-xs"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="border-border flex items-center justify-between border-t pt-3">
        <span
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
        <Button type="submit" size="sm" disabled={!canSubmit} className="gap-1.5 rounded-full px-4">
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          <span>{submitLabel}</span>
        </Button>
      </div>
    </form>
  );
}
