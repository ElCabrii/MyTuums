import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { roleSelectAtom } from "@/atoms/moderation";
import {
  createTestQueryClient,
  makeTeamMember,
  queryFixtures,
  renderWithProviders,
} from "@/test/render";
import { TeamView } from "@/components/moderation/team-view";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = { moderation: { team: vi.fn(), setRole: vi.fn() } };

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TeamView — rank gating on Change role", () => {
  it("lets an admin manage a staff member", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({ id: "staff-1", name: "Staff One", role: "staff" }),
    ]);
    await renderWithProviders(<TeamView />, {
      queryClient,
      signedInAs: { id: "admin-1", role: "admin" },
    });

    expect(
      await screen.findByRole("button", { name: m.moderation_team_change_role() }),
    ).toBeInTheDocument();
  });

  it("hides Change role for a member at or above the viewer's own rank", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({ id: "staff-1", name: "Staff One", role: "staff" }),
      makeTeamMember({ id: "admin-2", name: "Other Admin", role: "admin" }),
    ]);
    await renderWithProviders(<TeamView />, {
      queryClient,
      signedInAs: { id: "staff-viewer", role: "staff" },
    });

    // Same-rank (staff managing staff) and above-rank (staff managing admin)
    // both refuse — `roleRank(member) < roleRank(viewer)` is strict.
    await screen.findByText("Staff One");
    expect(
      screen.queryByRole("button", { name: m.moderation_team_change_role() }),
    ).not.toBeInTheDocument();
  });

  it("never offers Change role on the viewer's own row", async () => {
    const queryClient = createTestQueryClient();
    // The seeded own row is ranked BELOW the viewer's session role
    // (moderator < admin) so the rank clause alone would pass `canManage` —
    // only the `member.id !== viewer?.id` guard can suppress the button
    // here. If that guard were deleted, this row would show Change role.
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({ id: "admin-1", name: "Self Admin", role: "moderator" }),
    ]);
    await renderWithProviders(<TeamView />, {
      queryClient,
      signedInAs: { id: "admin-1", role: "admin" },
    });

    await screen.findByText("Self Admin");
    expect(
      screen.queryByRole("button", { name: m.moderation_team_change_role() }),
    ).not.toBeInTheDocument();
  });
});

describe("TeamView — set-role dialog", () => {
  it("submits the picked role for the opened member and closes the dialog", async () => {
    fakeClient.moderation.setRole.mockResolvedValue({ userId: "mod-1", role: "staff" });
    // `setRole`'s `onSuccess` invalidates `moderation.team` (`atoms/moderation.ts`), and unlike
    // the other files here the team query IS actively mounted, so this actually refetches —
    // an unstubbed resolution here logs React Query's "query data cannot be undefined" warning.
    fakeClient.moderation.team.mockResolvedValue({ items: [] });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({
        id: "mod-1",
        name: "Mod One",
        username: "mod1",
        displayUsername: "Mod1",
        role: "moderator",
      }),
    ]);
    const { store } = await renderWithProviders(<TeamView />, {
      queryClient,
      signedInAs: { id: "admin-1", role: "admin" },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.moderation_team_change_role() }));
    expect(
      await screen.findByRole("heading", { name: m.moderation_set_role_title({ handle: "mod1" }) }),
    ).toBeInTheDocument();

    // The Select popup is base-ui's floating listbox, which this suite
    // doesn't drive by pointer elsewhere either — the pick is applied the
    // way the trigger's `onValueChange` would, and the assertions below pin
    // the dialog's REACTION to that pick (button enabling, submit payload,
    // close-on-submit), not the picking gesture itself.
    act(() => store.set(roleSelectAtom, "staff"));

    const submit = screen.getByRole("button", { name: m.moderation_set_role_submit() });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(fakeClient.moderation.setRole).toHaveBeenCalledWith(
        { userId: "mod-1", role: "staff" },
        expect.anything(),
      ),
    );
    expect(
      screen.queryByRole("heading", { name: m.moderation_set_role_title({ handle: "mod1" }) }),
    ).not.toBeInTheDocument();
  });

  it("keeps Save role disabled with no role picked yet", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({
        id: "mod-1",
        name: "Mod One",
        username: "mod1",
        displayUsername: "Mod1",
        role: "moderator",
      }),
    ]);
    await renderWithProviders(<TeamView />, {
      queryClient,
      signedInAs: { id: "admin-1", role: "admin" },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.moderation_team_change_role() }));

    expect(screen.getByRole("button", { name: m.moderation_set_role_submit() })).toBeDisabled();
    expect(fakeClient.moderation.setRole).not.toHaveBeenCalled();
  });

  it("offers a staff viewer only user and moderator — never staff or admin", async () => {
    // Mirrors the server rule this dialog is a client mirror of
    // (`packages/api/src/moderation.ts`'s `setRole`: granting staff or above
    // requires admin, else FORBIDDEN). A staff viewer outranks this
    // moderator target, so Change role is offered, but the granted set must
    // stop at moderator — reverting `grantable` to always `ALL_ROLES` would
    // leave a staff viewer able to hand out staff/admin and this test is the
    // only place that would notice.
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({
        id: "mod-1",
        name: "Mod One",
        username: "mod1",
        displayUsername: "Mod1",
        role: "moderator",
      }),
    ]);
    await renderWithProviders(<TeamView />, {
      queryClient,
      signedInAs: { id: "staff-1", role: "staff" },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.moderation_team_change_role() }));

    // The Select popup stays mounted (just visually hidden) whether or not
    // it's open, so its offered options can be read without driving the
    // pointer-based open gesture team-view.test.tsx avoids elsewhere — but
    // base-ui's floating positioner mounts it a tick after the trigger
    // itself appears, so this waits rather than asserting synchronously.
    const listbox = await screen.findByRole("listbox", { hidden: true });
    const offered = within(listbox)
      .getAllByRole("option", { hidden: true })
      .map((option) => option.textContent);
    expect(offered).toEqual([m.moderation_role_user(), m.moderation_role_moderator()]);
  });
});
