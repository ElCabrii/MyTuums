import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTestQueryClient, makeUserSummary } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { FollowListDialog } from "@/components/follow-list-dialog";
import { m } from "@/paraglide/messages.js";

describe("FollowListDialog", () => {
  it("mounts the list only while open, and unmounts it on close", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).userList.data("alexmercer", "followers", [
      {
        items: [makeUserSummary({ name: "Jamie Rivera", username: "jamierivera" })],
        nextCursor: null,
      },
    ]);

    await renderWithProviders(
      <FollowListDialog
        username="alexmercer"
        handle="alexmercer"
        direction="followers"
        count={2}
      />,
      { queryClient, signedInAs: true },
    );

    // Closed: the dialog trigger (the count) is visible, but the list body
    // — which would issue the request — hasn't mounted. Asserting this is
    // the whole point of `followListDialogAtom` holding the open dialog's
    // *identity*: a profile visit shouldn't pay for a list nobody opened.
    expect(screen.queryByText("Jamie Rivera")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Followers/ }));

    expect(await screen.findByText("Jamie Rivera")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: m.common_close() }));

    await waitFor(() => expect(screen.queryByText("Jamie Rivera")).not.toBeInTheDocument());
  });
});
