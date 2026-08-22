import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { SearchBox } from "@/components/search-box";
import {
  debounceMs,
  debouncedSearchQueryAtom,
  searchHighlightAtom,
  searchInputAtom,
} from "@/atoms/search";
import { orpc, type SearchTypeahead } from "@/lib/orpc";
import { createTestQueryClient, makeUserSummary, renderWithProviders } from "@/test/render";

/**
 * Opens the typeahead dropdown the way a user does: a query already in the
 * atoms (written directly — the debounce belongs to `setSearchQueryAtom`),
 * then a focus on the input, whose onFocus handler opens the popup when the
 * query is non-empty. Deliberately NOT a pointer click: in jsdom every
 * element has a zero-size rect, so `elementFromPoint` tie-breaks
 * unpredictably between the input and the ✕ button that overlays it, and a
 * click can land on the ✕ and clear the query. The typeahead query is
 * seeded in the cache, so the rows render without a network call.
 */
async function openSuggestions(query: string, payload: SearchTypeahead) {
  const store = createStore();
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(orpc.search.typeahead.queryKey({ input: { q: query } }), payload);
  store.set(searchInputAtom, query);
  store.set(debouncedSearchQueryAtom, query);

  const result = await renderWithProviders(<SearchBox />, { store, queryClient });
  const user = userEvent.setup();
  act(() => screen.getByRole("combobox").focus());
  return { ...result, user };
}

describe("SearchBox suggestions", () => {
  it("renders profile and see-all rows from the typeahead cache", async () => {
    await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
    });

    // The accessible name concatenates the avatar's initials fallback with
    // the display name and handle, so the queries match on a stable
    // substring rather than the exact computed name.
    expect(screen.getByRole("option", { name: /Alex Mercer/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "See all results" })).toBeInTheDocument();
  });

  it("navigates to the profile on a user-row click and dismisses the list", async () => {
    const { router, user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
    });
    const input = screen.getByRole("combobox");

    await user.click(screen.getByRole("option", { name: /Alex Mercer/ }));

    expect(router.state.location.pathname).toBe("/@alexmercer");
    // The row's click contract: dismiss sets the focus-return guard and
    // closes the popup before the row's own navigation runs.
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    // Base UI has already returned focus by this point; the closed assertion
    // above proves that focus did not resurrect the list. A later genuine
    // focus opens it again.
    act(() => input.blur());
    act(() => input.focus());
    expect(screen.getByRole("option", { name: /Alex Mercer/ })).toBeInTheDocument();
  });

  it("dismisses the list when the user clicks outside", async () => {
    const { user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
    });

    await user.click(document.body);

    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("shows the no-results line instead of a lone see-all row for an empty payload", async () => {
    const { router } = await openSuggestions("hello", { users: [] });

    expect(screen.getByRole("option", { name: "No results for “hello”." })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "See all results" })).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("see-all row appears with results and carries the query into /search", async () => {
    const { router, user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
    });

    await user.click(screen.getByRole("option", { name: "See all results" }));

    expect(router.state.location.pathname).toBe("/search");
    expect(router.state.location.search).toMatchObject({ q: "hello" });
  });

  it("clear empties the input and hands the caret back", async () => {
    const { store, user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
    });
    const input = screen.getByRole("combobox");
    expect(screen.getByRole("option", { name: /Alex Mercer/ })).toBeInTheDocument();

    // While the popup is open, base-ui marks the trigger chrome aria-hidden
    // (the same treatment a modal gives its outside content), so the ✕ is
    // hidden from the accessibility tree — but not from the pointer: in a
    // real browser it stays clickable, and `hidden: true` is what lets the
    // test click it the way a sighted user would. An aria-hidden element
    // computes no accessible name (it is excluded from the tree), so the
    // label is asserted directly rather than through the name filter.
    const clearButton = screen.getByRole("button", { hidden: true });
    expect(clearButton).toHaveAttribute("aria-label", "Clear search");
    await user.click(clearButton);

    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(store.get(searchInputAtom)).toBe("");
  });
});

describe("SearchBox debounce and keyboard contract", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates the input immediately but lands only the final debounced query after 300 ms", async () => {
    const store = createStore();
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(orpc.search.typeahead.queryKey({ input: { q: "ab" } }), {
      users: [makeUserSummary({ name: "Able User", username: "able" })],
    });
    await renderWithProviders(<SearchBox />, { store, queryClient });
    vi.useFakeTimers();
    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "a" } });
    expect(input).toHaveValue("a");
    expect(store.get(searchInputAtom)).toBe("a");
    expect(store.get(debouncedSearchQueryAtom)).toBe("");

    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.change(input, { target: { value: "ab" } });
    expect(input).toHaveValue("ab");
    expect(store.get(debouncedSearchQueryAtom)).toBe("");

    act(() => {
      vi.advanceTimersByTime(debounceMs - 1);
    });
    expect(store.get(debouncedSearchQueryAtom)).toBe("");
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(store.get(debouncedSearchQueryAtom)).toBe("ab");
    expect(screen.getByRole("option", { name: /Able User/ })).toBeInTheDocument();
  });

  it("wraps the shared highlight and exposes it through combobox ARIA state", async () => {
    const { store } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
    });
    const press = (key: "ArrowDown" | "ArrowUp") => {
      // Base UI may replace its trigger element while reconciling the open
      // popup, so always dispatch to the currently rendered combobox rather
      // than retaining a stale element reference across updates.
      fireEvent.keyDown(screen.getByRole("combobox"), { key });
    };
    const expectActive = (index: number) => {
      expect(screen.getByRole("combobox")).toHaveAttribute(
        "aria-activedescendant",
        `search-suggestion-${index}`,
      );
      expect(screen.getAllByRole("option")[index]).toHaveAttribute("aria-selected", "true");
    };

    press("ArrowDown");
    expect(store.get(searchHighlightAtom)).toBe(0);
    expectActive(0);

    press("ArrowDown");
    expectActive(1);

    press("ArrowDown");
    expect(store.get(searchHighlightAtom)).toBe(0);
    expectActive(0);

    press("ArrowUp");
    expectActive(1);
  });

  it.each([
    { label: "user", arrows: "{ArrowDown}", pathname: "/@alexmercer" },
    {
      label: "see-all",
      arrows: "{ArrowDown}{ArrowDown}",
      pathname: "/search",
    },
  ])("Enter follows the highlighted $label row", async ({ arrows, pathname }) => {
    const { router, user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
    });

    await user.keyboard(`${arrows}{Enter}`);

    expect(router.state.location.pathname).toBe(pathname);
    if (pathname === "/search") {
      expect(router.state.location.search).toMatchObject({ q: "hello" });
    }
    // Enter closes the popover before navigating. Base UI returns focus to
    // the trigger as part of that close; the destination must stay clear
    // rather than reopening the non-empty query on focus return.
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("Enter without a highlight opens the full search page", async () => {
    const { router, user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
    });

    await user.keyboard("{Enter}");

    expect(router.state.location.pathname).toBe("/search");
    expect(router.state.location.search).toMatchObject({ q: "hello" });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("reopens suggestions on the first real focus after Enter navigation", async () => {
    const { user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
    });
    const input = screen.getByRole("combobox");

    await user.keyboard("{Enter}");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    act(() => input.blur());
    act(() => input.focus());
    expect(screen.getByRole("option", { name: /Alex Mercer/ })).toBeInTheDocument();
  });

  it("Escape preserves the query, clears the highlight, and stays dismissed through focus return", async () => {
    const { store, user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
    });
    const input = screen.getByRole("combobox");
    await user.keyboard("{ArrowDown}{Escape}");

    expect(input).toHaveValue("hello");
    expect(store.get(searchHighlightAtom)).toBe(-1);
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    act(() => input.blur());
    act(() => input.focus());
    expect(screen.getByRole("option", { name: /Alex Mercer/ })).toBeInTheDocument();
  });
});
