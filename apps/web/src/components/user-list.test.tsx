import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import {
  createTestQueryClient,
  makeUserSummary,
  renderWithProviders,
  seedInfiniteError,
  seedInfiniteLoading,
  seedUserListPages,
  userListQueryKey,
} from "@/test/render";
import { UserList } from "@/components/user-list";
import { m } from "@/paraglide/messages.js";

describe("UserList", () => {
  it("shows a loading spinner while the list is pending", async () => {
    const queryClient = createTestQueryClient();
    seedInfiniteLoading(queryClient, userListQueryKey("alexmercer", "followers"));

    const { container } = await renderWithProviders(
      <UserList username="alexmercer" direction="followers" emptyMessage="No followers yet." />,
      { queryClient },
    );

    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a retryable error when the list fails to load", async () => {
    const queryClient = createTestQueryClient();
    seedInfiniteError(queryClient, userListQueryKey("alexmercer", "followers"), "Could not load followers.");

    await renderWithProviders(
      <UserList username="alexmercer" direction="followers" emptyMessage="No followers yet." />,
      { queryClient },
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not load followers.");
    expect(screen.getByRole("button", { name: m.common_try_again() })).toBeInTheDocument();
  });

  it("shows the empty message when there are no people in the list", async () => {
    const queryClient = createTestQueryClient();
    seedUserListPages(queryClient, "alexmercer", "followers", [{ items: [], nextCursor: null }]);

    await renderWithProviders(
      <UserList username="alexmercer" direction="followers" emptyMessage="No followers yet." />,
      { queryClient },
    );

    expect(screen.getByText("No followers yet.")).toBeInTheDocument();
  });

  it("renders one row per person, each linking to their profile by normalised handle", async () => {
    const queryClient = createTestQueryClient();
    const jamie = makeUserSummary({ name: "Jamie Rivera", username: "jamierivera", displayUsername: "JamieRivera" });
    // `displayUsername` differs in casing from the normalised `username` —
    // the link must use the normalised one (see CLAUDE.md on handleOf), or
    // it would fragment the `byUsername` cache across casings.
    const casey = makeUserSummary({ name: "Casey Nolan", username: "caseynolan", displayUsername: "CaseyNolan" });
    seedUserListPages(queryClient, "alexmercer", "followers", [
      { items: [jamie, casey], nextCursor: null },
    ]);

    await renderWithProviders(
      <UserList username="alexmercer" direction="followers" emptyMessage="No followers yet." />,
      { queryClient, signedInAs: true },
    );

    expect(screen.getByRole("link", { name: /Jamie Rivera/ })).toHaveAttribute("href", "/@jamierivera");
    expect(screen.getByRole("link", { name: /Casey Nolan/ })).toHaveAttribute("href", "/@caseynolan");
  });

  it("shows Load more only when there is a next page", async () => {
    const withNextPage = createTestQueryClient();
    seedUserListPages(withNextPage, "alexmercer", "followers", [
      { items: [makeUserSummary()], nextCursor: "cursor-1" },
    ]);
    const more = await renderWithProviders(
      <UserList username="alexmercer" direction="followers" emptyMessage="No followers yet." />,
      { queryClient: withNextPage },
    );
    expect(screen.getByRole("button", { name: m.common_load_more() })).toBeInTheDocument();
    more.unmount();

    const withoutNextPage = createTestQueryClient();
    seedUserListPages(withoutNextPage, "alexmercer", "followers", [
      { items: [makeUserSummary()], nextCursor: null },
    ]);
    await renderWithProviders(
      <UserList username="alexmercer" direction="followers" emptyMessage="No followers yet." />,
      { queryClient: withoutNextPage },
    );
    expect(screen.queryByRole("button", { name: m.common_load_more() })).not.toBeInTheDocument();
  });
});
