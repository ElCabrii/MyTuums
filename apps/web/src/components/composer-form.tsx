import { AlertCircle, Loader2, Send } from "lucide-react";
import { POST_MAX_LENGTH } from "@my-tuums/api/constants";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { initialsOf } from "@/lib/user";

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
  header?: React.ReactNode;
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
      className="p-4 rounded-xl border border-border bg-card shadow-sm space-y-3"
    >
      {header}

      <div className="flex gap-3">
        <Avatar className="h-10 w-10 bg-background">
          <AvatarImage src={author.image || undefined} alt={author.name} />
          <AvatarFallback className="bg-primary text-primary-foreground font-bold text-xs">
            {initialsOf(author.name)}
          </AvatarFallback>
        </Avatar>
        <textarea
          rows={rows}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          disabled={isPending}
          className="w-full resize-none border-none bg-transparent p-0 text-sm focus:outline-none focus:ring-0 placeholder:text-muted-foreground disabled:opacity-60"
        />
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-2.5 text-xs text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-3">
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
