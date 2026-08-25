import { useAtom, useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { composerMentionAtomFamily } from "@/atoms/composer-mentions";
import { typeaheadQueryAtomFamily } from "@/atoms/search";
import { UserAvatar } from "@/components/user-avatar";
import { insertMention, mentionAtCaret } from "@/lib/composer-mentions";
import { nextHighlight, suggestionRows, type SuggestionRow } from "@/lib/search-suggestions";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

/** Auto-resize ceiling for editors that grow with their text (the composer). */
const MAX_HEIGHT = 256;

/** The user rows a mention dropdown can accept: profiles with a resolvable handle. */
function mentionUsers(rows: SuggestionRow[]): Extract<SuggestionRow, { kind: "user" }>[] {
  return rows.filter(
    (row): row is Extract<SuggestionRow, { kind: "user" }> =>
      row.kind === "user" && handleOf(row.user) !== null,
  );
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
 * A textarea with `@handle` completion — the shared seam behind both the
 * post/reply composer and the bio editor.
 *
 * Owns the caret-tracking, the suggestion listbox, the keyboard navigation and
 * the caret-restore guard an accepted mention needs, all keyed by
 * `mentionScope` so two mounted editors never share transient highlight state.
 * What stays caller-owned is the one thing that genuinely differs: where the
 * text lives. `value`/`onValueChange` route every keystroke and every accepted
 * mention back to the caller's draft atom — a composer draft or
 * `profileBioDraftAtom` — so the completion writes through the same atom the
 * field already binds, never a composer-specific one.
 *
 * `autoResize` grows the field with its text up to a ceiling, the composer's
 * expanding box; the bio editor leaves it off and keeps its fixed `rows`.
 */
export function MentionTextarea({
  value,
  onValueChange,
  mentionScope,
  placeholder,
  className,
  wrapperClassName,
  rows,
  id,
  disabled = false,
  autoResize = false,
}: {
  value: string;
  onValueChange: (next: string) => void;
  /** Primitive key for transient mention state; distinct per editor surface. */
  mentionScope: string;
  placeholder?: string;
  /** Classes on the textarea itself — each caller styles its own field. */
  className?: string;
  /** Classes on the relative wrapper that anchors the suggestion overlay. */
  wrapperClassName?: string;
  rows?: number;
  id?: string;
  disabled?: boolean;
  autoResize?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const suppressSelectionRef = useRef(false);
  const [mentionState, setMentionState] = useAtom(composerMentionAtomFamily(mentionScope));
  const mentionQuery = mentionState.token?.query ?? "";
  const typeahead = useAtomValue(typeaheadQueryAtomFamily(mentionQuery));
  const rowsForQuery = mentionUsers(suggestionRows(typeahead.data));
  // Suggestions suppress while the field is disabled — a disabled textarea
  // cannot be typed into, so an open list has no source gesture to keep it up.
  const showMentionSuggestions =
    !disabled && mentionState.open && (typeahead.isPending || rowsForQuery.length > 0);

  useEffect(
    () => () => {
      setMentionState({ token: null, highlight: -1, open: false });
    },
    [setMentionState],
  );

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (autoResize) {
      textarea.style.height = "auto";
      const height = Math.min(textarea.scrollHeight, MAX_HEIGHT);
      if (height > 0) textarea.style.height = `${height}px`;
      textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    }

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
  }, [value, autoResize]);

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

  const wrapperClass = wrapperClassName ? `relative ${wrapperClassName}` : "relative";

  return (
    <div className={wrapperClass}>
      <textarea
        ref={textareaRef}
        id={id}
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
        disabled={disabled}
        className={className}
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
  );
}
