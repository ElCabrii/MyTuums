import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createTestQueryClient, makeUserSummary } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { UserList } from "@/components/user-list";

// The pending / error / empty / Load-more branches are PaginatedState's, owned
// by paginated-state.test.tsx — this file only proves UserList's own wiring:
// that its atom's people reach UserRow with the right composition.
describe("UserList", () => {
  it("renders one row per person, each linking to their profile by normalised handle", async () => {
    const queryClient = createTestQueryClient();
    const jamie = makeUserSummary({
      name: "Jamie Rivera",
      username: "jamierivera",
      displayUsername: "JamieRivera",
    });
    // A stale pre-backfill shape whose display field differs in casing must
    // still link through the canonical username, or it would fragment the
    // `byUsername` cache across casings.
    const casey = makeUserSummary({
      name: "Casey Nolan",
      username: "caseynolan",
      displayUsername: "CaseyNolan",
    });
    queryFixtures(queryClient).userList.data("alexmercer", "followers", [
      { items: [jamie, casey], nextCursor: null },
    ]);

    await renderWithProviders(
      <UserList username="alexmercer" direction="followers" emptyMessage="No followers yet." />,
      { queryClient, signedInAs: true },
    );

    expect(screen.getByRole("link", { name: /Jamie Rivera/ })).toHaveAttribute(
      "href",
      "/@jamierivera",
    );
    expect(screen.getByRole("link", { name: /Casey Nolan/ })).toHaveAttribute(
      "href",
      "/@caseynolan",
    );
  });
});
