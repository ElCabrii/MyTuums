import { describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import { SearchPage } from "@/components/search-page";
import {
  makeAuthor,
  makePost,
  makeUserSummary,
  renderWithProviders,
  seedSearchPostsPages,
  seedSearchUsersPages,
} from "@/test/render";

describe("SearchPage", () => {
  it("renders the type-something prompt when the URL carries no query", async () => {
    await renderWithProviders(<SearchPage />, { initialPath: "/search" });

    expect(screen.getByText("Type something to search people and posts.")).toBeInTheDocument();
  });

  /**
   * Regression for issue #49: the results body used to call its two
   * `useAtomValue`s inside JSX attribute expressions *after* an `if (!q)`
   * early return, so navigating `/search` → `/search?q=...` — a search-param
   * change TanStack Router re-renders the route component for, rather than
   * remounting it — went from one hook to three on the same instance, and
   * React threw ("Rendered more hooks than during the previous render").
   *
   * The router is what makes this a faithful reproduction: `SearchPage`
   * reads `routeApi.useSearch()` off the matched `/search` route, so the
   * navigation must go through `router.navigate` (the header's SearchBox
   * does exactly this) and not a prop change.
   */
  it("survives the /search → /search?q=... transition and renders both sections", async () => {
    const { router, queryClient } = await renderWithProviders(<SearchPage />, {
      initialPath: "/search",
    });

    // Both infinite queries are seeded for q="hello" (the harness's
    // refetchOnMount: false means the seeded pages render as-is, with no
    // network call), so the assertion below is "both sections rendered their
    // rows" and not "both sections rendered their error alerts".
    seedSearchUsersPages(queryClient, "hello", [
      { items: [makeUserSummary({ name: "Alex Mercer" })], nextCursor: null },
    ]);
    seedSearchPostsPages(queryClient, "hello", [
      // Distinct author name — `makePost`'s default author is also Alex
      // Mercer, which would trip the name assertion below twice.
      {
        items: [
          makePost({ content: "Hello, world!", author: makeAuthor({ name: "Dana Scully" }) }),
        ],
        nextCursor: null,
      },
    ]);

    await act(async () => {
      await router.navigate({ to: "/search", search: { q: "hello" } });
    });

    expect(screen.getByRole("heading", { name: "Results for “hello”" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Posts" })).toBeInTheDocument();
    expect(screen.getByText("Alex Mercer")).toBeInTheDocument();
    expect(screen.getByText("Dana Scully")).toBeInTheDocument();
  });
});
