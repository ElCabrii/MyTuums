import { useEffect, useRef } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Loader2, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/user-avatar";
import {
  resetSearchAtomsAtom,
  searchHighlightAtom,
  searchInputAtom,
  searchPopoverOpenAtom,
  setSearchQueryAtom,
  typeaheadAtom,
} from "@/atoms/search";
import {
  nextHighlight,
  suggestionRows,
  type SuggestionRow as SuggestionRowData,
} from "@/lib/search-suggestions";
import { handleOf } from "@/lib/user";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";

/**
 * The event base-ui's prop merge hands the rendered element: the library's
 * own trigger handlers are wrapped into the same synthetic event, which gains
 * a `preventBaseUIHandler` method (absent from React's types) that stops them
 * from running. See `mergeProps` in base-ui's docs.
 */
type BaseUiMergedEvent = React.SyntheticEvent & { preventBaseUIHandler?: () => void };

/**
 * Where an Enter press on a highlighted row goes — the same destinations the
 * row links render, so keyboard and pointer land in the same place. A user
 * row without a handle has no URL, so it falls back to the search page
 * rather than dropping the press.
 */
function destinationOf(
  row: SuggestionRowData,
  query: string
):
  | { to: "/@{$username}"; params: { username: string } }
  | { to: "/post/$postId"; params: { postId: string } }
  | { to: "/search"; search: { q: string } } {
  switch (row.kind) {
    case "user": {
      const handle = handleOf(row.user);
      return handle
        ? { to: "/@{$username}", params: { username: handle } }
        : { to: "/search", search: { q: query } };
    }
    case "post":
      return { to: "/post/$postId", params: { postId: row.post.id } };
    case "see-all":
      return { to: "/search", search: { q: query } };
  }
}

/**
 * The stable list key for a suggestion row — user and post ids, and a static
 * literal for the single see-all entry. Keys live here rather than inside
 * `SuggestionRow` because React consumes them at the list site (the `.map`
 * in `SuggestionList`), not where the element's JSX is written.
 */
function suggestionRowKey(row: SuggestionRowData): string {
  switch (row.kind) {
    case "user":
      return row.user.id;
    case "post":
      return row.post.id;
    case "see-all":
      return "search-see-all";
  }
}

/**
 * One option in the suggestions list: a user row (with a link when the user
 * has a handle, a plain row otherwise), a post row, or the see-all entry —
 * the four shapes `suggestionRows` can emit.
 *
 * Rows share one interaction contract: hover selects (keyboard and pointer
 * share a single highlight) and a click dismisses before the row's own
 * navigation runs — the click sets the focus-return guard in `SearchBox`
 * (`dismiss`), which is why the handlers come in as props instead of being
 * built here: the ref write must stay at component scope (see `dismiss`),
 * and react-hooks/refs cannot see event-handler props through an object
 * spread, so they attach as explicit props per element.
 */
function SuggestionRow({
  row,
  index,
  isActive,
  query,
  onSelect,
  onDismiss,
}: {
  row: SuggestionRowData;
  index: number;
  isActive: boolean;
  /** The current input value — the see-all row links to /search with it. */
  query: string;
  onSelect: (index: number) => void;
  onDismiss: () => void;
}) {
  // `id` is the other half of the aria-activedescendant pair: the input in
  // `SearchField` points at `search-suggestion-${highlight}`, so this format
  // must match exactly or the combobox loses its announced active option.
  const rowProps = {
    id: `search-suggestion-${index}`,
    role: "option" as const,
    "aria-selected": isActive,
    className: cn(
      "flex items-center gap-3 px-2.5 py-2 rounded-lg cursor-pointer",
      isActive && "bg-muted/60"
    ),
  };

  if (row.kind === "user") {
    const handle = handleOf(row.user);
    const displayName = row.user.name || handle || m.user_unknown();
    return handle ? (
      <Link
        to="/@{$username}"
        params={{ username: handle }}
        {...rowProps}
        onMouseEnter={() => onSelect(index)}
        onClick={onDismiss}
      >
        <UserAvatar
          user={row.user}
          alt={displayName}
          className="h-8 w-8 shrink-0"
          fallbackClassName="text-xs font-bold bg-primary text-primary-foreground"
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            @{handle}
          </span>
        </span>
      </Link>
    ) : (
      <div {...rowProps} onMouseEnter={() => onSelect(index)} onClick={onDismiss}>
        <UserAvatar
          user={row.user}
          alt={displayName}
          className="h-8 w-8 shrink-0"
          fallbackClassName="text-xs font-bold bg-primary text-primary-foreground"
        />
        <span className="block truncate text-sm font-medium text-foreground">
          {displayName}
        </span>
      </div>
    );
  }

  if (row.kind === "post") {
    const authorName = row.post.author.name || handleOf(row.post.author) || m.user_unknown();
    return (
      <Link
        to="/post/$postId"
        params={{ postId: row.post.id }}
        {...rowProps}
        onMouseEnter={() => onSelect(index)}
        onClick={onDismiss}
      >
        <UserAvatar
          user={row.post.author}
          alt={authorName}
          className="h-8 w-8 shrink-0"
          fallbackClassName="text-xs font-bold bg-primary text-primary-foreground"
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {authorName}
          </span>
          <span className="block line-clamp-1 text-xs text-muted-foreground">
            {/* Null only for removed posts (see post-card.tsx). */}
            {row.post.content ?? ""}
          </span>
        </span>
      </Link>
    );
  }

  return (
    <Link
      to="/search"
      search={{ q: query }}
      {...rowProps}
      onMouseEnter={() => onSelect(index)}
      onClick={onDismiss}
      className={cn(rowProps.className, "mt-1.5 border-t border-border/60 pt-1.5")}
    >
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-sm font-medium">{m.search_see_all()}</span>
    </Link>
  );
}

/**
 * The dropdown body: the four states of the typeahead query — spinner,
 * error, no-results, and the rows themselves. Split out of `SearchBox` so
 * the box stays a thin shell (input + popup + keyboard wiring) and the
 * list's own branching lives here.
 */
function SuggestionList({
  typeahead,
  rows,
  query,
  highlight,
  onSelect,
  onDismiss,
}: {
  typeahead: { data: unknown; isPending: boolean; isError: boolean };
  rows: SuggestionRowData[];
  query: string;
  highlight: number;
  onSelect: (index: number) => void;
  onDismiss: () => void;
}) {
  if (typeahead.isPending) {
    return (
      <div role="option" className="flex items-center justify-center py-3">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (typeahead.isError) {
    return (
      <div role="option" className="px-2.5 py-2 text-sm text-muted-foreground">
        {m.search_load_error()}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div role="option" className="px-2.5 py-2 text-sm text-muted-foreground">
        {m.search_no_results({ query })}
      </div>
    );
  }

  return (
    <>
      {rows.map((row, i) => (
        <SuggestionRow
          key={suggestionRowKey(row)}
          row={row}
          index={i}
          isActive={i === highlight}
          query={query}
          onSelect={onSelect}
          onDismiss={onDismiss}
        />
      ))}
    </>
  );
}

/**
 * The combobox's trigger chrome: the magnifier, the input and the clear
 * button. Owns `inputRef` — the clear button hands the caret back to the
 * input — so the ref never crosses a prop boundary. The handlers come in as
 * props from `SearchBox`, which owns the atoms they write.
 */
function SearchField({
  value,
  open,
  highlight,
  onValueChange,
  onFocus,
  onKeyDown,
  onTriggerClick,
  onClear,
}: {
  value: string;
  open: boolean;
  highlight: number;
  onValueChange: (value: string) => void;
  onFocus: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onTriggerClick: (event: React.SyntheticEvent) => void;
  onClear: (value: string) => void;
}) {
  // Reached from the clear button: clearing must hand the caret straight
  // back to the input so the next keystroke lands in the query, not on the
  // button.
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <PopoverTrigger
        render={
          <Input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={open}
            // base-ui injects `aria-haspopup="dialog"` on its triggers; the
            // popup is a listbox, so the hint is overridden to match.
            aria-haspopup="listbox"
            aria-controls="search-suggestions"
            aria-label={m.search_input_aria()}
            placeholder={m.nav_search_placeholder()}
            // The other half of the aria-activedescendant pair: the rows in
            // `SuggestionRow` render `search-suggestion-${index}` — this
            // format must match exactly or the combobox loses its announced
            // active option.
            aria-activedescendant={
              open && highlight >= 0 ? `search-suggestion-${highlight}` : undefined
            }
            // `pr-9` clears room for the custom ✕. The browser's own search
            // cancel is hidden: it is unstylable (the native glyph shows up
            // in accent color and answers the cursor with a default arrow),
            // so the app draws the button it can style instead.
            className="w-full pl-9 pr-9 bg-muted/50 focus-visible:bg-background [&::-webkit-search-cancel-button]:hidden"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onFocus={onFocus}
            onKeyDown={onKeyDown}
            onClick={onTriggerClick}
          />
        }
      />
      {/* Clearing is not dismissing: `onValueChange("")` closes the list on
          its own — but only after an empty query, which never reopens the
          list. The caret goes back to the input so typing continues; the ref
          lives here precisely so the focus stays inside the component that
          owns it. */}
      {value !== "" && (
        <button
          type="button"
          aria-label={m.search_clear()}
          onClick={() => {
            onClear("");
            inputRef.current?.focus();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full cursor-pointer text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5 pointer-events-none" />
        </button>
      )}
    </div>
  );
}

/**
 * The popup half of the combobox: the listbox element (its id, aria-label,
 * focus policy and sizing — the chrome the `SuggestionList` body renders
 * inside) and the four-state body itself. Split out of `SearchBox` so the
 * box's render is just the trigger and the popup, and the popup's own
 * chrome and branching live here.
 */
function SuggestionPopover(props: {
  typeahead: { data: unknown; isPending: boolean; isError: boolean };
  rows: SuggestionRowData[];
  query: string;
  highlight: number;
  onSelect: (index: number) => void;
  onDismiss: () => void;
}) {
  return (
    <PopoverContent
      id="search-suggestions"
      role="listbox"
      aria-label={m.search_suggestions_aria()}
      // Base UI's default moves focus into the popup on open
      // (createDefaultInitialFocus → "first focusable"), which would yank
      // the caret out of the combobox the moment a keystroke opened the
      // list. This is an aria-activedescendant combobox — the input owns
      // the keyboard, the listbox only mirrors the highlight — so focus
      // must stay put. `finalFocus` still returns it after a dismiss.
      initialFocus={false}
      // The width is explicit because base-ui's Positioner sizes to the
      // popup's own content, never the trigger — without `w-96` the list
      // would collapse to the widest row. `max-w` keeps the list inside
      // the viewport on narrow screens. The trailing classes are the same
      // acrylic recipe the header's dropdown menus use (translucent
      // surface + backdrop blur behind a pseudo-element): the plain
      // `bg-popover` from the wrapper would render the panel opaque, which
      // reads as a different material than the rest of the navbar.
      className="w-96 max-w-[calc(100vw-2rem)] p-1.5 gap-0.5 relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150 dark:ring-foreground/10"
    >
      <SuggestionList {...props} />
    </PopoverContent>
  );
}

/**
 * The header's live search box: a combobox input with a typeahead dropdown
 * of matching users and posts and a see-all entry into the /search results
 * page. Keyboard (arrows, Enter, Escape) and pointer (hover, click) share a
 * single highlight state, so either mode picks up where the other left off.
 */
export function SearchBox() {
  const navigate = useNavigate();
  const inputValue = useAtomValue(searchInputAtom);
  const setSearchQuery = useSetAtom(setSearchQueryAtom);
  const [open, setOpen] = useAtom(searchPopoverOpenAtom);
  const [highlight, setHighlight] = useAtom(searchHighlightAtom);
  const typeahead = useAtomValue(typeaheadAtom);
  const resetSearch = useSetAtom(resetSearchAtomsAtom);
  // Guards the open-on-focus behavior against the focus return that follows a
  // dismissal. Closing the popup (row click, Escape) moves focus back to the
  // input via base-ui's returnFocus; without the guard that focus event would
  // re-run the onFocus open and instantly resurrect the dropdown on the page
  // it just navigated to. The guard is consumed by exactly that one event, so
  // a later real focus (clicking back into the input) still reopens.
  const dismissedRef = useRef(false);

  // The rows' click contract, hoisted to component scope: dismissing sets the
  // focus-return guard (see dismissedRef above) before closing the popup. It
  // cannot live inside the render-created row handlers — react-hooks/refs
  // flags any ref write in an inline arrow it cannot prove runs after commit,
  // and this is the one ref the rows write. The list children receive it as
  // a prop and attach it to each row.
  const dismiss = () => {
    dismissedRef.current = true;
    setOpen(false);
  };

  // The query atoms are module-scoped and the header outlives the pages
  // beneath it, so without a reset they would keep the previous session's
  // query and popover state (the same unmount-reset pattern as login.tsx).
  useEffect(() => resetSearch, [resetSearch]);

  const rows = suggestionRows(typeahead.data);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlight(nextHighlight(highlight, +1, rows.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlight(nextHighlight(highlight, -1, rows.length));
        break;
      case "Enter": {
        event.preventDefault();
        const highlightedRow = highlight >= 0 ? rows[highlight] : undefined;
        setOpen(false);
        if (highlightedRow) {
          void navigate(destinationOf(highlightedRow, inputValue));
        } else {
          void navigate({ to: "/search", search: { q: inputValue } });
        }
        break;
      }
      case "Escape":
        // Dismissing is not clearing — the query stays for the next focus.
        // Blur moves the caret's focus off the input so a following Enter
        // on the page cannot re-trigger the dropdown. The flag swallows the
        // focus return base-ui schedules when the close completes, which
        // would otherwise reopen the list (see dismissedRef above).
        dismissedRef.current = true;
        setOpen(false);
        setHighlight(-1);
        event.currentTarget.blur();
        break;
    }
  };

  const handleChange = (value: string) => {
    setSearchQuery(value);
    if (value.trim() !== "") {
      setOpen(true);
      setHighlight(-1);
    } else {
      // An emptied input has nothing to suggest — close rather than show a
      // stale list (the typeahead atom is gated off for empty queries).
      setOpen(false);
    }
  };

  const handleFocus = () => {
    if (dismissedRef.current) {
      // The focus return of a just-finished dismissal, not a user gesture —
      // let it pass without reopening.
      dismissedRef.current = false;
      return;
    }
    if (inputValue.trim() !== "") {
      setOpen(true);
      setHighlight(-1);
    }
  };

  const handleTriggerClick = (event: React.SyntheticEvent) => {
    // base-ui merges the trigger's own click handler — a toggle that would
    // dismiss the list on a repeated click — onto the rendered element. A
    // combobox must not toggle: the open state is owned by focus, typing and
    // outside press instead. `preventBaseUIHandler` is the escape hatch that
    // stops the library's handler, which runs after this one.
    (event as BaseUiMergedEvent).preventBaseUIHandler?.();
    if (inputValue.trim() !== "") setOpen(true);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <SearchField
        value={inputValue}
        open={open}
        highlight={highlight}
        onValueChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        onTriggerClick={handleTriggerClick}
        onClear={handleChange}
      />
      <SuggestionPopover
        typeahead={typeahead}
        rows={rows}
        query={inputValue}
        highlight={highlight}
        onSelect={setHighlight}
        onDismiss={dismiss}
      />
    </Popover>
  );
}
