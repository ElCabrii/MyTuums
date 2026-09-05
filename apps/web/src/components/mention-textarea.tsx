import { useAtom, useAtomValue } from "jotai";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type Ref,
} from "react";
import { Loader2 } from "lucide-react";
import { composerMentionAtomFamily } from "@/atoms/composer-mentions";
import { typeaheadQueryAtomFamily } from "@/atoms/search";
import { GameCover } from "@/components/game-cover";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/user-avatar";
import {
  hashtagAtCaret,
  insertHashtag,
  insertMention,
  mentionAtCaret,
} from "@/lib/composer-mentions";
import { measureCaretLine } from "@/lib/caret-measure";
import { caretPanelPlacement } from "@/lib/caret-panel";
import { nextHighlight, suggestionRows, type SuggestionRow } from "@/lib/search-suggestions";
import { type SearchUser, type TypeaheadGame } from "@/lib/orpc";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";

/** A user the mention dropdown can accept: a profile with a resolvable handle. */
type MentionableUser = { user: SearchUser; handle: string };

/** A game the tag dropdown can accept, paired with its canonical hashtag key. */
type SuggestableGame = { game: TypeaheadGame; hashtagKey: string };

/** The games a tag dropdown can accept: the typeahead payload's games as-is. */
function suggestionGames(games: TypeaheadGame[] | undefined): SuggestableGame[] {
  return (games ?? []).map((game) => ({ game, hashtagKey: game.hashtagKey }));
}

/**
 * The user rows a mention dropdown can accept: profiles with a resolvable
 * handle. The handle is resolved here and carried with the row, so the
 * dropdown never re-derives it — and never guards a null it has already
 * filtered out.
 */
function mentionUsers(rows: SuggestionRow[]): MentionableUser[] {
  const users: MentionableUser[] = [];
  for (const row of rows) {
    if (row.kind !== "user") continue;
    const handle = handleOf(row.user);
    if (handle) users.push({ user: row.user, handle });
  }
  return users;
}

/**
 * Frame classes shared by the populated list and the loading spinner. The
 * panel stays full-width (`right-0 left-0`); only its `top` moves, and that
 * arrives as an inline style from the caret anchor below (issue #336) — so
 * there is deliberately no top/bottom class here. Before the first
 * measurement the panel takes its static position, just under the textarea,
 * which is also where it used to be pinned.
 */
const panelClass =
  "border-border bg-popover text-popover-foreground absolute right-0 left-0 z-50 rounded-xl border shadow-lg";

/** Gap between the caret line and the panel, in px — the old `0.5rem` offset. */
const PANEL_GAP_PX = 8;

/**
 * The panel's height budget for the flip decision before it has rendered and
 * measured itself, in px — matches the `max-h-60` cap on the lists below.
 */
const PANEL_MAX_HEIGHT_PX = 240;

function GameSuggestions({
  rows,
  highlight,
  onHighlight,
  onAccept,
  listboxId,
  optionId,
  panelRef,
  panelStyle,
}: {
  rows: SuggestableGame[];
  highlight: number;
  onHighlight: (index: number) => void;
  onAccept: (index: number) => void;
  listboxId: string;
  optionId: (index: number) => string;
  /** Measures the rendered panel for the caret anchor's flip decision. */
  panelRef: Ref<HTMLDivElement>;
  /** The caret anchor's `top` — the panel's only positioning. */
  panelStyle: CSSProperties | undefined;
}) {
  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label={m.composer_game_suggestions_aria()}
      ref={panelRef}
      style={panelStyle}
      className={`${panelClass} max-h-60 overflow-y-auto p-1.5`}
    >
      {rows.map((row, index) => (
        <button
          key={row.game.slug}
          type="button"
          role="option"
          aria-selected={index === highlight}
          id={optionId(index)}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onAccept(index)}
          className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left ${
            index === highlight ? "bg-muted/60" : ""
          }`}
        >
          <div className="bg-muted h-8 w-6 shrink-0 overflow-hidden rounded-sm">
            <GameCover cover={row.game.coverMediaPath} name={row.game.name} sizes="32px" />
          </div>
          <span className="min-w-0">
            <span className="text-foreground block truncate text-sm font-medium">
              {row.game.name}
            </span>
            {/* The key is the contract: accepting writes exactly this tag. */}
            <span className="text-muted-foreground block truncate text-xs">#{row.hashtagKey}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function MentionSuggestions({
  rows,
  highlight,
  onHighlight,
  onAccept,
  listboxId,
  optionId,
  panelRef,
  panelStyle,
}: {
  rows: MentionableUser[];
  highlight: number;
  onHighlight: (index: number) => void;
  onAccept: (index: number) => void;
  /** Id of the listbox element; also the textarea's `aria-controls` target. */
  listboxId: string;
  /** Builds the option id for a given index; mirrors `aria-activedescendant`. */
  optionId: (index: number) => string;
  /** Measures the rendered panel for the caret anchor's flip decision. */
  panelRef: Ref<HTMLDivElement>;
  /** The caret anchor's `top` — the panel's only positioning. */
  panelStyle: CSSProperties | undefined;
}) {
  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label={m.composer_mention_suggestions_aria()}
      ref={panelRef}
      style={panelStyle}
      className={`${panelClass} max-h-60 overflow-y-auto p-1.5`}
    >
      {rows.map((row, index) => {
        const displayName = row.user.name || row.handle;

        return (
          <button
            key={row.user.id}
            type="button"
            role="option"
            aria-selected={index === highlight}
            id={optionId(index)}
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
              <span className="text-muted-foreground block truncate text-xs">@{row.handle}</span>
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
 * mention back to the caller's draft atom — a composer draft or a bio draft
 * atom — so the completion writes through the same atom the field already
 * binds, never a composer-specific one.
 *
 * The field is the shadcn `Textarea` primitive, which auto-grows with its text
 * via `field-sizing-content`; a caller's `max-h-*` caps the growth and scrolls
 * past it — the composer's expanding box. The bio editor opts back out with
 * `field-sizing: fixed` to keep a fixed `rows`.
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
  style,
  disabled = false,
  enableGameSuggestions = false,
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
  /**
   * Inline styles on the textarea. Higher specificity than the primitive's
   * classes, so this is how a caller overrides a class-based property the
   * primitive bakes in — the bio editor's `field-sizing: fixed`, which a
   * class-based override loses to the primitive's `field-sizing-content` on
   * source order.
   */
  style?: CSSProperties;
  disabled?: boolean;
  /**
   * Whether `#tag` completion offers games (issue #314, Q4). The post, reply
   * and quote composers say yes; the bio editor says no — a bio's hashtags
   * render through the same linkifier but the bio has no batch map, so
   * suggesting a resolvable tag there would promise a link it cannot keep.
   */
  enableGameSuggestions?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const suppressSelectionRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // The panel's `top` in px from the wrapper's top edge — the caret anchor
  // (issue #336). Null until the first measurement; the panel then takes
  // its static position just under the textarea for exactly one frame.
  const [panelTop, setPanelTop] = useState<number | null>(null);
  const [mentionState, setMentionState] = useAtom(composerMentionAtomFamily(mentionScope));
  const mentionQuery = mentionState.token?.query ?? "";
  const typeahead = useAtomValue(typeaheadQueryAtomFamily(mentionQuery));
  // Which kind of token is active is a property of the marker the state's
  // token was found under — one token, one kind, never both.
  const completingHashtag = mentionState.token !== null && value[mentionState.token.start] === "#";
  const userRows = completingHashtag ? [] : mentionUsers(suggestionRows(typeahead.data));
  const gameRows = completingHashtag ? suggestionGames(typeahead.data?.games) : [];
  const activeRowCount = completingHashtag ? gameRows.length : userRows.length;
  // Suggestions suppress while the field is disabled — a disabled textarea
  // cannot be typed into, so an open list has no source gesture to keep it up.
  const showMentionSuggestions =
    !disabled && mentionState.open && (typeahead.isPending || activeRowCount > 0);

  // Namespaced once so the listbox/option ids and the ARIA wiring all agree,
  // and so two editors on the same page never collide on a duplicate id.
  const listboxId = `${mentionScope}-mention-suggestions`;
  const optionId = (index: number) => `${mentionScope}-mention-${index}`;

  useEffect(
    () => () => {
      setMentionState({ token: null, highlight: -1, open: false });
    },
    [setMentionState],
  );

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

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

  // Anchors the suggestion panel to the caret line (issue #336). The mirror
  // measures the caret in the textarea's frame; adding the textarea's own
  // offset within the relative wrapper converts to the panel's frame, minus
  // the scroll the mirror never sees. Runs on every state change while open
  // — typing moves the caret, and loading-to-rows swaps the panel height the
  // flip decision reads — and writes state only when the offset moved, so a
  // highlight-only arrow press re-measures but never re-renders. A reopened
  // panel never flashes a stale anchor: this is a layout effect, so the
  // fresh measurement lands before the browser paints.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !showMentionSuggestions) return;
    const line = measureCaretLine(textarea, textarea.selectionStart ?? textarea.value.length);
    const placement = caretPanelPlacement({
      caretTop: textarea.offsetTop + line.top - textarea.scrollTop,
      lineHeight: line.lineHeight,
      gap: PANEL_GAP_PX,
      panelHeight: panelRef.current?.offsetHeight || PANEL_MAX_HEIGHT_PX,
      caretViewportBottom: line.viewportBottom,
      viewportHeight: window.innerHeight,
    });
    setPanelTop((previous) => (previous === placement.top ? previous : placement.top));
  }, [showMentionSuggestions, mentionState, value, typeahead.isPending, activeRowCount]);

  const updateMentionState = (nextValue: string, start: number | null, end: number | null) => {
    if (suppressSelectionRef.current) return;
    // The caret sits in at most one token kind; `@` wins when both parsers
    // could claim it (they cannot — a token's marker differs).
    const token =
      mentionAtCaret(nextValue, start, end) ??
      (enableGameSuggestions ? hashtagAtCaret(nextValue, start, end) : null);
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
    const token = mentionState.token;
    if (!token) return;
    // The active kind's row at the highlighted index — an out-of-range index
    // (no rows for this query) simply accepts nothing.
    const insertion = completingHashtag
      ? gameRows[index] && insertHashtag(value, token, gameRows[index].hashtagKey)
      : userRows[index] && insertMention(value, token, userRows[index].handle);
    if (!insertion) return;

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
          highlight: nextHighlight(previous.highlight, 1, activeRowCount),
        }));
        break;
      case "ArrowUp":
        event.preventDefault();
        setMentionState((previous) => ({
          ...previous,
          highlight: nextHighlight(previous.highlight, -1, activeRowCount),
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

  const wrapperClass = ["relative", wrapperClassName].filter(Boolean).join(" ");
  // The caret anchor's inline style: the panel's only positioning (the frame
  // class carries no top). Undefined until the first measurement.
  const panelStyle: CSSProperties | undefined = panelTop === null ? undefined : { top: panelTop };

  return (
    <div className={wrapperClass}>
      {/* No `role="combobox"` here, deliberately: the implicit `textbox`
          role of a `<textarea>` does not allow it (axe's aria-allowed-role,
          flagged on the live audit), and the combobox role expects a
          single-line control. The suggestion popup keeps its full ARIA
          wiring through attributes `textbox` DOES support —
          `aria-autocomplete`, `aria-controls` and `aria-activedescendant`
          below — which is the same shape the search box's true `<input>`
          combobox uses, minus the role a textarea cannot carry.
          `aria-expanded` is dropped with it: it is not supported on
          `textbox` either, and the listbox's appearance plus the
          activedescendant pair already carry the open state. */}
      <Textarea
        ref={textareaRef}
        id={id}
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
        aria-controls={showMentionSuggestions ? listboxId : undefined}
        aria-activedescendant={
          showMentionSuggestions && mentionState.highlight >= 0
            ? optionId(mentionState.highlight)
            : undefined
        }
        disabled={disabled}
        className={className}
        style={style}
      />
      {showMentionSuggestions &&
        (completingHashtag ? (
          <GameSuggestions
            rows={gameRows}
            highlight={mentionState.highlight}
            onHighlight={(index) =>
              setMentionState((previous) => ({ ...previous, highlight: index }))
            }
            onAccept={acceptMention}
            listboxId={listboxId}
            optionId={optionId}
            panelRef={panelRef}
            panelStyle={panelStyle}
          />
        ) : typeahead.isPending ? (
          <div
            id={listboxId}
            role="listbox"
            aria-label={m.composer_mention_suggestions_aria()}
            ref={panelRef}
            style={panelStyle}
            className={`${panelClass} flex items-center justify-center p-4`}
          >
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          </div>
        ) : (
          <MentionSuggestions
            rows={userRows}
            highlight={mentionState.highlight}
            onHighlight={(index) =>
              setMentionState((previous) => ({ ...previous, highlight: index }))
            }
            onAccept={acceptMention}
            listboxId={listboxId}
            optionId={optionId}
            panelRef={panelRef}
            panelStyle={panelStyle}
          />
        ))}
    </div>
  );
}
