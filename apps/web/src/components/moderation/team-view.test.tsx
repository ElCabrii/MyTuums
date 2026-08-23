import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { debounceMs } from "@/atoms/search";
import { debouncedTeamSearchAtom, roleSelectAtom, teamSearchInputAtom } from "@/atoms/moderation";
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

const fakeClient = { moderation: { team: vi.fn(), setRole: vi.fn(), searchUsers: vi.fn() } };

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TeamView — profile links", () => {
  it("links a member's avatar and name through their canonical handle", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({
        id: "staff-1",
        name: "Staff One",
        username: "staff-one",
        displayUsername: "Staff-One",
        role: "staff",
      }),
    ]);
    await renderWithProviders(<TeamView />, {
      queryClient,
      signedInAs: { id: "admin-1", role: "admin" },
    });

    const profileLinks = await screen.findAllByRole("link", { name: "Staff One" });
    expect(profileLinks).toHaveLength(2);
    for (const profileLink of profileLinks) {
      expect(profileLink).toHaveAttribute("href", "/@staff-one");
    }
  });

  it("leaves a member without a handle non-interactive", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({
        id: "staff-1",
        name: "Staff One",
        username: null,
        displayUsername: null,
        role: "staff",
      }),
    ]);
    await renderWithProviders(<TeamView />, {
      queryClient,
      signedInAs: { id: "admin-1", role: "admin" },
    });

    expect(await screen.findByText("Staff One")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Staff One" })).not.toBeInTheDocument();
  });
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
    // both refuse — `canManageRole` is strictly greater.
    await screen.findByText("Staff One");
    expect(
      screen.queryByRole("button", { name: m.moderation_team_change_role() }),
    ).not.toBeInTheDocument();
  });

  it("never offers Change role on the viewer's own row", async () => {
    const queryClient = createTestQueryClient();
    // The viewer's own row carries the same role as their session, so
    // `canManageRole(viewerRole, viewerRole)` is false (strictly greater) and
    // the button is suppressed without a separate self-check.
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({ id: "admin-1", name: "Self Admin", role: "admin" }),
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

  it("offers a staff viewer only roles below their rank other than the target's current role", async () => {
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
    expect(offered).toEqual([m.moderation_role_user()]);
  });
});

describe("TeamView — the account lookup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lands the debounced query and lists an account holding no role at all", async () => {
    // The roster's own answer to "who is on the team" cannot contain this
    // account — which is exactly why the lookup exists (issue #145).
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.team([]);
    queryFixtures(queryClient).moderation.teamSearch("zoe", [
      makeTeamMember({ id: "user-1", name: "Zoe Plain", username: "zoe", role: "user" }),
    ]);
    await renderWithProviders(<TeamView />, {
      queryClient,
      signedInAs: { id: "admin-1", role: "admin" },
    });
    // Same shape as the SearchBox's debounce test: fake timers and
    // `fireEvent.change`, because userEvent drives its own clock.
    vi.useFakeTimers();

    const field = screen.getByLabelText(m.moderation_team_search_label());
    fireEvent.change(field, { target: { value: "zoe" } });
    // Nothing fires until the field has been still for the full delay — the
    // roster is still what's on screen.
    expect(screen.queryByText("Zoe Plain")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(debounceMs);
    });

    expect(screen.getByText("Zoe Plain")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.moderation_team_change_role() })).toBeEnabled();
  });

  it("promotes an account picked out of the lookup", async () => {
    fakeClient.moderation.setRole.mockResolvedValue({ userId: "user-1", role: "moderator" });
    // Both queries are invalidated by `setRole`'s onSuccess and both are
    // mounted here, so both actually refetch (see the roster test above).
    fakeClient.moderation.team.mockResolvedValue({ items: [] });
    fakeClient.moderation.searchUsers.mockResolvedValue({ items: [] });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.teamSearch("zoe", [
      makeTeamMember({
        id: "user-1",
        name: "Zoe Plain",
        username: "zoe",
        displayUsername: "Zoe",
        role: "user",
      }),
    ]);
    // The query written straight into the atoms, the way `openSuggestions`
    // does in `search-box.test.tsx`: the debounce belongs to
    // `setTeamSearchAtom` and is pinned by the test above, so this one starts
    // from the state a settled keystroke leaves behind.
    const store = createStore();
    store.set(teamSearchInputAtom, "zoe");
    store.set(debouncedTeamSearchAtom, "zoe");
    await renderWithProviders(<TeamView />, {
      store,
      queryClient,
      signedInAs: { id: "admin-1", role: "admin" },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.moderation_team_change_role() }));
    expect(
      await screen.findByRole("heading", { name: m.moderation_set_role_title({ handle: "zoe" }) }),
    ).toBeInTheDocument();

    const listbox = await screen.findByRole("listbox", { hidden: true });
    const offered = within(listbox)
      .getAllByRole("option", { hidden: true })
      .map((option) => option.textContent);
    expect(offered).toEqual([
      m.moderation_role_moderator(),
      m.moderation_role_staff(),
      m.moderation_role_admin(),
    ]);

    act(() => store.set(roleSelectAtom, "moderator"));
    await user.click(screen.getByRole("button", { name: m.moderation_set_role_submit() }));

    await waitFor(() =>
      expect(fakeClient.moderation.setRole).toHaveBeenCalledWith(
        { userId: "user-1", role: "moderator" },
        expect.anything(),
      ),
    );
  });

  it("hides settled lookup rows while the next query is still debouncing", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.teamSearch("zoe", [
      makeTeamMember({ id: "user-1", name: "Zoe Plain", username: "zoe", role: "user" }),
    ]);
    const store = createStore();
    store.set(teamSearchInputAtom, "zoe");
    store.set(debouncedTeamSearchAtom, "zoe");
    await renderWithProviders(<TeamView />, {
      store,
      queryClient,
      signedInAs: { id: "admin-1", role: "admin" },
    });
    await screen.findByText("Zoe Plain");
    vi.useFakeTimers();

    fireEvent.change(screen.getByLabelText(m.moderation_team_search_label()), {
      target: { value: "alex" },
    });

    expect(screen.queryByText("Zoe Plain")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: m.moderation_team_change_role() }),
    ).not.toBeInTheDocument();
  });

  it("applies the same rank guard to lookup results as to the roster", async () => {
    // The lookup reaches every account, including ones the viewer may not
    // touch — the server refuses those, and the row must not offer a button
    // that can only fail.
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.teamSearch("boss", [
      makeTeamMember({ id: "admin-2", name: "Boss Admin", username: "boss", role: "admin" }),
    ]);
    const store = createStore();
    store.set(teamSearchInputAtom, "boss");
    store.set(debouncedTeamSearchAtom, "boss");
    await renderWithProviders(<TeamView />, {
      store,
      queryClient,
      signedInAs: { id: "staff-1", role: "staff" },
    });

    expect(await screen.findByText("Boss Admin")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: m.moderation_team_change_role() }),
    ).not.toBeInTheDocument();
  });

  it("brings the roster back when the field is cleared", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({ id: "mod-1", name: "Mod One", username: "mod1", role: "moderator" }),
    ]);
    queryFixtures(queryClient).moderation.teamSearch("zoe", [
      makeTeamMember({ id: "user-1", name: "Zoe Plain", username: "zoe", role: "user" }),
    ]);
    const store = createStore();
    store.set(teamSearchInputAtom, "zoe");
    store.set(debouncedTeamSearchAtom, "zoe");
    await renderWithProviders(<TeamView />, {
      store,
      queryClient,
      signedInAs: { id: "admin-1", role: "admin" },
    });
    await screen.findByText("Zoe Plain");

    fireEvent.change(screen.getByLabelText(m.moderation_team_search_label()), {
      target: { value: "" },
    });

    expect(await screen.findByText("Mod One")).toBeInTheDocument();
    expect(screen.queryByText("Zoe Plain")).not.toBeInTheDocument();
  });
});
