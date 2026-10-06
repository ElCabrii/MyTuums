import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { installTestClient } from "@/lib/orpc";
import { renderWithProviders } from "@/test/render";
import { JoinGroupButton } from "@/components/message-group-invitation";

const join = vi.fn();
beforeEach(() => {
  join.mockReset();
  installTestClient({ message: { join } });
});

it("a join requiring confirmation opens a warning and cancellation leaves the invitation unaccepted", async () => {
  join.mockResolvedValue({ conversationId: "c", requiresConfirmation: true });
  await renderWithProviders(<JoinGroupButton conversationId="c" />, { signedInAs: true });
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByRole("dialog", { name: "A blocked member is in this group" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Join" })).toBeVisible();
});
