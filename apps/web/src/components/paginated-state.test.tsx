import { MessageSquare } from "lucide-react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PaginatedState, type PaginatedStateQuery } from "@/components/paginated-state";
import { m } from "@/paraglide/messages.js";

/**
 * The four-state skeleton (spinner / retry alert / dashed empty / Load more)
 * is owned HERE, once. The seven consumer components each only prove their own
 * wiring — that their atom's data reaches their row renderer — and restate
 * none of these branches (see the comments on their trimmed test files).
 */
const query = (overrides: Partial<PaginatedStateQuery> = {}): PaginatedStateQuery => ({
  isPending: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
  ...overrides,
});

const ui = (query: PaginatedStateQuery) => (
  <PaginatedState
    query={query}
    errorMessage="fallback message"
    emptyIcon={MessageSquare}
    emptyMessage="Nothing here yet."
    isEmpty={false}
  >
    <p>row one</p>
  </PaginatedState>
);

describe("PaginatedState", () => {
  it("shows a spinner while the query is pending", () => {
    const { container } = render(ui(query({ isPending: true })));

    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the caller's skeleton instead of the spinner when one is passed", () => {
    render(
      <PaginatedState
        query={query({ isPending: true })}
        errorMessage="fallback"
        emptyIcon={MessageSquare}
        emptyMessage="empty"
        isEmpty={false}
        loadingFallback={<p>row-shaped skeleton</p>}
      >
        rows
      </PaginatedState>,
    );

    expect(screen.getByText("row-shaped skeleton")).toBeInTheDocument();
    expect(screen.queryByText("rows")).not.toBeInTheDocument();
  });

  it("shows a retryable alert carrying the error's own message, and refetches on Try again", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    render(ui(query({ isError: true, error: { message: "Could not load posts." }, refetch })));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not load posts.");
    await user.click(screen.getByRole("button", { name: m.common_try_again() }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("falls back to the caller's message when the error carries none", () => {
    render(ui(query({ isError: true, error: null })));

    expect(screen.getByRole("alert")).toHaveTextContent("fallback message");
  });

  it("shows the dashed empty state with the caller's message and action instead of rows", () => {
    render(
      <PaginatedState
        query={query()}
        errorMessage="fallback"
        emptyIcon={MessageSquare}
        emptyMessage="Nothing here yet."
        isEmpty={true}
        emptyAction={<button type="button">Find people to follow</button>}
      >
        <p>row one</p>
      </PaginatedState>,
    );

    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find people to follow" })).toBeInTheDocument();
    expect(screen.queryByText("row one")).not.toBeInTheDocument();
  });

  it("renders the loaded children", () => {
    render(ui(query()));

    expect(screen.getByText("row one")).toBeInTheDocument();
  });

  it("offers Load more only when there is a next page, disabled while it is in flight, and fetches on click", async () => {
    const user = userEvent.setup();
    const fetchNextPage = vi.fn();
    const { rerender } = render(
      <PaginatedState
        query={query({ hasNextPage: true, fetchNextPage })}
        errorMessage="fallback"
        emptyIcon={MessageSquare}
        emptyMessage="empty"
        isEmpty={false}
      >
        rows
      </PaginatedState>,
    );

    const more = screen.getByRole("button", { name: m.common_load_more() });
    expect(more).toBeEnabled();
    await user.click(more);
    expect(fetchNextPage).toHaveBeenCalledOnce();

    rerender(
      <PaginatedState
        query={query({ hasNextPage: true, isFetchingNextPage: true, fetchNextPage })}
        errorMessage="fallback"
        emptyIcon={MessageSquare}
        emptyMessage="empty"
        isEmpty={false}
      >
        rows
      </PaginatedState>,
    );
    expect(screen.getByRole("button", { name: m.common_load_more() })).toBeDisabled();

    rerender(
      <PaginatedState
        query={query({ hasNextPage: false, fetchNextPage })}
        errorMessage="fallback"
        emptyIcon={MessageSquare}
        emptyMessage="empty"
        isEmpty={false}
      >
        rows
      </PaginatedState>,
    );
    expect(screen.queryByRole("button", { name: m.common_load_more() })).not.toBeInTheDocument();
  });
});
