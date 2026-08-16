import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createTestQueryClient,
  makeAuditEntry,
  makeTeamMember,
  queryFixtures,
  renderWithProviders,
} from "@/test/render";
import { ModerationPage } from "@/components/moderation/moderation-page";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

// Every mutation atom `CaseDialog` reads unconditionally on mount, plus the
// three queries this page's tabs can open — none are ever actually called
// (nothing here opens a case or clicks an action), but `createTanstackQueryUtils`'s
// proxy still needs a defined value at each path segment to build a key or a
// mutation's options object without throwing (see case-dialog.test.tsx).
const fakeClient = {
  moderation: {
    queue: vi.fn(),
    case: vi.fn(),
    auditLog: vi.fn(),
    team: vi.fn(),
    removePost: vi.fn(),
    restorePost: vi.fn(),
    resolve: vi.fn(),
    suspendUser: vi.fn(),
    banUser: vi.fn(),
    unbanUser: vi.fn(),
    appealReview: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

/** Seeds an empty first page for every query the page's three tabs can mount. */
function seedEmptyEverything(queryClient: ReturnType<typeof createTestQueryClient>) {
  const fixtures = queryFixtures(queryClient);
  fixtures.moderation.queue([{ items: [], nextCursor: null }]);
  fixtures.moderation.auditLog([{ items: [], nextCursor: null }]);
  fixtures.moderation.team([]);
}

describe("ModerationPage — role gate", () => {
  it("renders RoleForbiddenPage instead of the desk for a plain signed-in user", async () => {
    await renderWithProviders(<ModerationPage />, { signedInAs: { role: "user" } });

    expect(
      await screen.findByRole("heading", { name: m.moderation_forbidden_title() }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});

describe("ModerationPage — tab gating", () => {
  it("shows only the Queue tab to a moderator, with no way to reach Audit log or Team", async () => {
    const queryClient = createTestQueryClient();
    seedEmptyEverything(queryClient);
    await renderWithProviders(<ModerationPage />, {
      queryClient,
      signedInAs: { role: "moderator" },
    });

    expect(await screen.findByRole("tab", { name: m.moderation_tab_queue() })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: m.moderation_tab_audit() })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: m.moderation_tab_team() })).not.toBeInTheDocument();
    // The queue's own empty state, proving QueueView actually mounted under
    // the gate rather than the whole page rendering nothing.
    expect(await screen.findByText(m.moderation_queue_empty())).toBeInTheDocument();
  });

  it("shows Audit log and Team to staff, and each renders its own seeded rows on click", async () => {
    const queryClient = createTestQueryClient();
    seedEmptyEverything(queryClient);
    queryFixtures(queryClient).moderation.auditLog([
      { items: [makeAuditEntry({ action: "user_banned" })], nextCursor: null },
    ]);
    queryFixtures(queryClient).moderation.team([
      makeTeamMember({ name: "Sam Staff", role: "staff" }),
    ]);
    await renderWithProviders(<ModerationPage />, { queryClient, signedInAs: { role: "staff" } });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: m.moderation_tab_audit() }));
    expect(await screen.findByText(m.moderation_action_user_banned())).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: m.moderation_tab_team() }));
    expect(await screen.findByText("Sam Staff")).toBeInTheDocument();
  });
});
