import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createTestQueryClient,
  makeModerationCase,
  makeModerationCaseDetail,
  renderWithProviders,
  seedModerationCase,
  seedModerationQueuePages,
} from "@/test/render";
import { QueueView } from "@/components/moderation/queue-view";
import { m } from "@/paraglide/messages.js";

// None of these are actually invoked in this file — the row-click test only
// opens the dialog, it never clicks an action — but `CaseBody` reads every
// mutation atom unconditionally on mount (`useAtomValue`, not lazily), and
// `createTanstackQueryUtils`'s proxy indexes into the fake client one path
// segment at a time, so a missing segment throws before mount even finishes
// (see case-dialog.test.tsx's fuller version of this comment).
const { fakeClient } = vi.hoisted(() => ({
  fakeClient: {
    moderation: {
      queue: vi.fn(),
      case: vi.fn(),
      removePost: vi.fn(),
      restorePost: vi.fn(),
      resolve: vi.fn(),
      suspendUser: vi.fn(),
      banUser: vi.fn(),
      unbanUser: vi.fn(),
      appealReview: vi.fn(),
    },
  },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { orpc: createTanstackQueryUtils(fakeClient) };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QueueView", () => {
  it("shows an open appeal with a badge, and a report count in the right plural form", async () => {
    const queryClient = createTestQueryClient();
    seedModerationQueuePages(queryClient, [
      {
        items: [
          makeModerationCase({
            targetType: "post",
            targetId: "post-1",
            reportCount: 3,
            reasons: ["spam"],
            appeal: { id: "appeal-1", reason: "wasn't spam", createdAt: new Date() },
          }),
        ],
        nextCursor: null,
      },
    ]);
    await renderWithProviders(<QueueView />, { queryClient, signedInAs: { role: "moderator" } });

    expect(await screen.findByText(m.moderation_queue_appeal())).toBeInTheDocument();
    expect(screen.getByText(m.moderation_case_reports_many({ count: "3" }))).toBeInTheDocument();
    expect(
      screen.queryByText(m.moderation_case_reports_one({ count: "1" })),
    ).not.toBeInTheDocument();
  });

  it("uses the singular report count for exactly one report, and no appeal badge without an open appeal", async () => {
    const queryClient = createTestQueryClient();
    seedModerationQueuePages(queryClient, [
      {
        items: [
          makeModerationCase({
            targetType: "user",
            targetId: "user-1",
            reportCount: 1,
            reasons: ["harassment"],
            appeal: null,
          }),
        ],
        nextCursor: null,
      },
    ]);
    await renderWithProviders(<QueueView />, { queryClient, signedInAs: { role: "moderator" } });

    expect(
      await screen.findByText(m.moderation_case_reports_one({ count: "1" })),
    ).toBeInTheDocument();
    expect(screen.queryByText(m.moderation_queue_appeal())).not.toBeInTheDocument();
  });

  it("opens the case dialog for the clicked row's exact target", async () => {
    const queryClient = createTestQueryClient();
    seedModerationQueuePages(queryClient, [
      {
        items: [
          makeModerationCase({ targetType: "post", targetId: "post-42", reasons: ["spam"] }),
          // A second row with a DIFFERENT target — proves the click opened
          // the one that was clicked, not just "a" case.
          makeModerationCase({ targetType: "post", targetId: "post-99", reasons: ["nsfw"] }),
        ],
        nextCursor: null,
      },
    ]);
    seedModerationCase(
      queryClient,
      { targetType: "post", targetId: "post-42" },
      makeModerationCaseDetail({ id: "post-42", content: "The flagged post" }),
    );
    await renderWithProviders(<QueueView />, { queryClient, signedInAs: { role: "moderator" } });

    // Closed: neither the dialog nor a case fetch has happened yet.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const user = userEvent.setup();
    // The row is a bare `<button>` with no dedicated label — its accessible
    // name is its own rendered text, so "Spam" (the reason summary) picks
    // out the post-42 row specifically, not the post-99 ("NSFW") one.
    await user.click(screen.getByRole("button", { name: /Spam/ }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("The flagged post")).toBeInTheDocument();
  });
});
