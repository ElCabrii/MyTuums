import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { SearchBox } from "@/components/search-box";
import { debouncedSearchQueryAtom, searchInputAtom } from "@/atoms/search";
import { orpc, type SearchTypeahead } from "@/lib/orpc";
import {
  createTestQueryClient,
  makeAuthor,
  makePost,
  makeUserSummary,
  renderWithProviders,
} from "@/test/render";

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
  it("renders the user, post and see-all rows from the typeahead cache", async () => {
    await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
      posts: [
        makePost({
          content: "Hello, world!",
          author: makeAuthor({ name: "Dana Scully", username: "dscully" }),
        }),
      ],
    });

    // The accessible name concatenates the avatar's initials fallback with
    // the display name and handle, so the queries match on a stable
    // substring rather than the exact computed name.
    expect(screen.getByRole("option", { name: /Alex Mercer/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Hello, world!/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "See all results" })).toBeInTheDocument();
  });

  it("navigates to the profile on a user-row click and dismisses the list", async () => {
    const { router, user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
      posts: [],
    });

    await user.click(screen.getByRole("option", { name: /Alex Mercer/ }));

    expect(router.state.location.pathname).toBe("/@alexmercer");
    // The row's click contract: dismiss sets the focus-return guard and
    // closes the popup before the row's own navigation runs.
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("shows the no-results line instead of a lone see-all row for an empty payload", async () => {
    const { router } = await openSuggestions("hello", { users: [], posts: [] });

    expect(screen.getByRole("option", { name: "No results for “hello”." })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "See all results" })).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("see-all row appears with results and carries the query into /search", async () => {
    const { router, user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
      posts: [],
    });

    await user.click(screen.getByRole("option", { name: "See all results" }));

    expect(router.state.location.pathname).toBe("/search");
    expect(router.state.location.search).toMatchObject({ q: "hello" });
  });

  it("clear empties the input and hands the caret back", async () => {
    const { store, user } = await openSuggestions("hello", {
      users: [makeUserSummary({ name: "Alex Mercer", username: "alexmercer" })],
      posts: [],
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
