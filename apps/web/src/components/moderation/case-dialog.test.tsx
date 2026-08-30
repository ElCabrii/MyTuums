import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createTestQueryClient,
  makeModerationCaseDetail,
  makeModerationReport,
  makeUserModerationCaseDetail,
} from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { CaseDialog } from "@/components/moderation/case-dialog";
import { DEFAULT_SUSPENSION_SECONDS, type CaseRef } from "@/atoms/moderation";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

/**
 * The mutation procedures the dialog's buttons call, plus `case` itself.
 * `case` is never actually invoked — the query fixture seeds its data
 * straight into the query cache — but `createTanstackQueryUtils`'s proxy
 * still indexes into the fake client one path segment at a time to build
 * `.queryKey()`, so a MISSING segment (rather than a stubbed one) throws
 * reading a property off `undefined` before the real network call it's
 * guarding against would ever happen. Same reasoning as the `queue`/`case`/
 * `auditLog` stubs in `atoms/moderation.test.ts` — and the same reason the
 * non-moderation groups are stubbed too: the review/unban/suspend success
 * sweeps read those keys, and a missing segment would turn every onSuccess
 * into a thrown error instead of a recorded review.
 */
const fakeClient = {
  post: { list: vi.fn(), thread: vi.fn() },
  search: { posts: vi.fn(), users: vi.fn(), typeahead: vi.fn() },
  user: { followers: vi.fn(), following: vi.fn(), byUsername: vi.fn() },
  moderation: {
    case: vi.fn(),
    removePost: vi.fn(),
    restorePost: vi.fn(),
    resolve: vi.fn(),
    suspendUser: vi.fn(),
    banUser: vi.fn(),
    unbanUser: vi.fn(),
    listBlocked: vi.fn(),
    queue: vi.fn(),
    auditLog: vi.fn(),
    team: vi.fn(),
    appealReview: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

/** Renders the dialog with `detail` already seeded, so `CaseBody` mounts synchronously. */
async function renderCase(target: CaseRef, detail: ReturnType<typeof makeModerationCaseDetail>) {
  const queryClient = createTestQueryClient();
  queryFixtures(queryClient).moderation.case(target, detail);
  return renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
    queryClient,
    signedInAs: { role: "moderator" },
  });
}

/** One open report — the dismiss action is gated on these, so dismiss tests seed one. */
function makeOpenReport() {
  return makeModerationReport();
}

describe("CaseDialog — mention rendering", () => {
  it("links mentions in the raw post content shown to moderators", async () => {
    const content = "Reported @Alice,\nwith context.";
    const target: CaseRef = { targetType: "post", targetId: "post-1" };
    await renderCase(target, makeModerationCaseDetail({ id: "post-1", content }));

    const mention = screen.getByRole("link", { name: "@Alice" });
    expect(mention).toHaveAttribute("href", "/@alice");
    expect(mention.closest("p")?.textContent).toBe(content);
  });

  // An image-only post (issue #202) stores `content` as ""; the case view
  // must omit the blank paragraph rather than render empty space above the
  // attachment grid.
  it("omits the content paragraph for an image-only post target", async () => {
    const target: CaseRef = { targetType: "post", targetId: "post-1" };
    const { container } = await renderCase(
      target,
      makeModerationCaseDetail({
        id: "post-1",
        content: "",
        attachments: [
          {
            id: "attachment-1",
            url: "/media/posts/author/post/attachment-1.png",
            position: 0,
            contentType: "image/png",
            byteSize: 24,
            width: 256,
            height: 128,
          },
        ],
      }),
    );

    // The stub-route <p> the test harness renders also matches a bare tag
    // query; the content paragraph is the one carrying `whitespace-pre-line`.
    expect(container.querySelector("p.whitespace-pre-line")).toBeNull();
    expect(screen.getByAltText(m.post_attachment_alt({ position: "1" }))).toBeInTheDocument();
  });
});

describe("CaseDialog — role gating on user actions", () => {
  const target: CaseRef = { targetType: "user", targetId: "user-1" };

  it("hides the Ban action from a moderator", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.case(
      target,
      makeUserModerationCaseDetail({ id: "user-1" }),
    );
    await renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
      queryClient,
      signedInAs: { role: "moderator" },
    });

    // Suspend is a moderator action, present either way — asserting it too is
    // what makes "Ban is missing" mean "gated", not "nothing rendered yet".
    expect(await screen.findByRole("button", { name: m.moderation_suspend() })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.moderation_ban() })).not.toBeInTheDocument();
  });

  it("shows the Ban action to staff", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.case(
      target,
      makeUserModerationCaseDetail({ id: "user-1" }),
    );
    await renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
      queryClient,
      signedInAs: { role: "staff" },
    });

    expect(await screen.findByRole("button", { name: m.moderation_ban() })).toBeInTheDocument();
  });

  it("staff clicking Ban submits the typed reason for the target user", async () => {
    fakeClient.moderation.banUser.mockResolvedValue({ userId: "user-1", banned: true });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.case(
      target,
      makeUserModerationCaseDetail({ id: "user-1" }),
    );
    await renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
      queryClient,
      signedInAs: { role: "staff" },
    });

    const banButton = await screen.findByRole("button", { name: m.moderation_ban() });
    expect(banButton).toBeDisabled();

    const user = userEvent.setup();
    // Both the suspend and ban sections use the same "Reason" label text —
    // `selector` disambiguates by the field this test actually cares about.
    await user.type(
      screen.getByLabelText(m.moderation_ban_reason_label(), { selector: "#case-ban-reason" }),
      "repeat offender",
    );
    expect(banButton).toBeEnabled();
    await user.click(banButton);

    await waitFor(() =>
      expect(fakeClient.moderation.banUser).toHaveBeenCalledWith(
        { userId: "user-1", reason: "repeat offender" },
        expect.anything(),
      ),
    );
  });
});

describe("CaseDialog — suspend flow", () => {
  const target: CaseRef = { targetType: "user", targetId: "user-1" };

  it("keeps Suspend disabled until a reason is entered, then submits the trimmed reason with the default duration", async () => {
    fakeClient.moderation.suspendUser.mockResolvedValue({ userId: "user-1", suspended: true });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.case(
      target,
      makeUserModerationCaseDetail({ id: "user-1" }),
    );
    await renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
      queryClient,
      signedInAs: { role: "moderator" },
    });

    const suspendButton = await screen.findByRole("button", { name: m.moderation_suspend() });
    expect(suspendButton).toBeDisabled();

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(m.moderation_suspend_reason_label(), {
        selector: "#case-suspend-reason",
      }),
      "  repeat spam  ",
    );
    expect(suspendButton).toBeEnabled();
    await user.click(suspendButton);

    // The duration picker's only preset select defaults to
    // `DEFAULT_SUSPENSION_SECONDS` (`atoms/moderation.ts`) — never touched
    // here, so this also pins that default reaching the mutation untouched.
    await waitFor(() =>
      expect(fakeClient.moderation.suspendUser).toHaveBeenCalledWith(
        { userId: "user-1", reason: "repeat spam", durationSeconds: DEFAULT_SUSPENSION_SECONDS },
        expect.anything(),
      ),
    );
  });
});

describe("CaseDialog — a banned target's actions", () => {
  const target: CaseRef = { targetType: "user", targetId: "user-1" };

  it("offers Unsuspend (not Unban) for a time-limited suspension, and hides the suspend/ban forms", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.case(
      target,
      makeUserModerationCaseDetail({
        id: "user-1",
        banned: true,
        banExpires: new Date("2099-01-01T00:00:00.000Z"),
      }),
    );
    await renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
      queryClient,
      signedInAs: { role: "staff" },
    });

    expect(
      await screen.findByRole("button", { name: m.moderation_unsuspend() }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.moderation_unban() })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.moderation_suspend() })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.moderation_ban() })).not.toBeInTheDocument();
  });

  it("offers Unban (not Unsuspend) for a permanent ban, and submits the target's id", async () => {
    fakeClient.moderation.unbanUser.mockResolvedValue({ userId: "user-1", unbanned: true });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.case(
      target,
      makeUserModerationCaseDetail({ id: "user-1", banned: true, banExpires: null }),
    );
    await renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
      queryClient,
      signedInAs: { role: "staff" },
    });

    const unbanButton = await screen.findByRole("button", { name: m.moderation_unban() });
    expect(
      screen.queryByRole("button", { name: m.moderation_unsuspend() }),
    ).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(unbanButton);

    await waitFor(() =>
      expect(fakeClient.moderation.unbanUser).toHaveBeenCalledWith(
        { userId: "user-1" },
        expect.anything(),
      ),
    );
  });

  // `unbanUser` is a `staffProcedure` server-side (`packages/api/src/moderation.ts`),
  // matching Ban's own gate — a moderator who saw this button would have it
  // 403 on click. This pins the fix, not just the current behaviour.
  it("hides Unban/Unsuspend from a moderator", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.case(
      target,
      makeUserModerationCaseDetail({ id: "user-1", banned: true, banExpires: null }),
    );
    await renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
      queryClient,
      signedInAs: { role: "moderator" },
    });

    // Something else on the card must have rendered first — otherwise an
    // absent button just means "nothing painted yet".
    await screen.findByText(m.moderation_case_reports_title());
    expect(screen.queryByRole("button", { name: m.moderation_unban() })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: m.moderation_unsuspend() }),
    ).not.toBeInTheDocument();
  });
});

describe("CaseDialog — post actions", () => {
  it("keeps Remove post disabled until a reason is entered, then submits the trimmed reason", async () => {
    fakeClient.moderation.removePost.mockResolvedValue({ postId: "post-1", removed: true });
    const target: CaseRef = { targetType: "post", targetId: "post-1" };
    await renderCase(target, makeModerationCaseDetail({ id: "post-1" }));

    const removeButton = await screen.findByRole("button", { name: m.moderation_remove_submit() });
    expect(removeButton).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.moderation_remove_reason_label()), "  spam content  ");
    expect(removeButton).toBeEnabled();
    await user.click(removeButton);

    // The click handler trims before sending — a lone `.mutate` call proves
    // both that the trim happened and that no extra request went out.
    await waitFor(() =>
      expect(fakeClient.moderation.removePost).toHaveBeenCalledWith(
        { postId: "post-1", reason: "spam content" },
        expect.anything(),
      ),
    );
    expect(fakeClient.moderation.removePost).toHaveBeenCalledTimes(1);
  });

  it("shows Restore instead of the reason form for an already-removed post, and submits its id", async () => {
    fakeClient.moderation.restorePost.mockResolvedValue({ postId: "post-1", restored: true });
    const target: CaseRef = { targetType: "post", targetId: "post-1" };
    // The real post-removal state: `removePostEffect` stamps every open report
    // in the same transaction that sets the tombstone, so a removed post has
    // `removedAt` set AND no open reports. Restore must still be reachable —
    // it is report-independent, and this is the only consumer of
    // `restorePostAtom` in the app.
    await renderCase(
      target,
      makeModerationCaseDetail(
        { id: "post-1", removedAt: new Date("2026-01-01T00:00:00.000Z") },
        {
          reports: [
            makeModerationReport({
              resolvedAt: new Date("2026-01-01T00:00:00.000Z"),
              resolvedBy: "moderator-1",
              resolvedOutcome: "actioned",
              resolutionNote: "removed",
            }),
          ],
        },
      ),
    );

    expect(
      screen.queryByRole("button", { name: m.moderation_remove_submit() }),
    ).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.moderation_restore_post() }));

    await waitFor(() =>
      expect(fakeClient.moderation.restorePost).toHaveBeenCalledWith(
        { postId: "post-1" },
        expect.anything(),
      ),
    );
  });
});

describe("CaseDialog — dismissing a case", () => {
  it("dismisses with the trimmed note, for either target's outcome/target payload", async () => {
    fakeClient.moderation.resolve.mockResolvedValue({
      targetType: "post",
      targetId: "post-1",
      resolved: 1,
    });
    const target: CaseRef = { targetType: "post", targetId: "post-1" };
    await renderCase(
      target,
      makeModerationCaseDetail({ id: "post-1" }, { reports: [makeOpenReport()] }),
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(m.moderation_dismiss_note_label()),
      "  not against the rules  ",
    );
    await user.click(await screen.findByRole("button", { name: m.moderation_dismiss() }));

    await waitFor(() =>
      expect(fakeClient.moderation.resolve).toHaveBeenCalledWith(
        {
          targetType: "post",
          targetId: "post-1",
          outcome: "dismissed",
          note: "not against the rules",
        },
        expect.anything(),
      ),
    );
  });
});

describe("CaseDialog — gating Dismiss on open reports", () => {
  const target: CaseRef = { targetType: "post", targetId: "post-1" };

  it("hides only the Dismiss action when every report is resolved, keeping the target action", async () => {
    await renderCase(
      target,
      makeModerationCaseDetail(
        { id: "post-1" },
        {
          reports: [
            makeModerationReport({
              resolvedAt: new Date(),
              resolvedBy: "moderator-1",
              resolvedOutcome: "actioned",
              resolutionNote: "removed",
            }),
          ],
        },
      ),
    );

    expect(await screen.findByText(m.moderation_case_reports_title())).toBeInTheDocument();
    // The card stays: the target action (Remove) is report-independent and must
    // remain reachable. Only the dismiss — whose whole job is stamping reports —
    // is withheld when there is nothing open to stamp (issue #59's no-op resolve).
    expect(screen.getByText(m.moderation_actions_title())).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.moderation_remove_submit() })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.moderation_dismiss() })).not.toBeInTheDocument();
  });

  it("keeps Dismiss when at least one report is still open", async () => {
    await renderCase(
      target,
      makeModerationCaseDetail(
        { id: "post-1" },
        {
          reports: [
            makeOpenReport(),
            makeModerationReport({
              resolvedAt: new Date(),
              resolvedBy: "moderator-1",
              resolvedOutcome: "dismissed",
              resolutionNote: null,
            }),
          ],
        },
      ),
    );

    expect(await screen.findByRole("button", { name: m.moderation_dismiss() })).toBeInTheDocument();
  });
});

describe("CaseDialog — appeal review", () => {
  const target: CaseRef = { targetType: "user", targetId: "user-1" };

  it("renders Uphold/Overturn for an open appeal and submits the outcome", async () => {
    fakeClient.moderation.appealReview.mockResolvedValue({
      appealId: "appeal-1",
      status: "overturned",
    });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.case(
      target,
      makeUserModerationCaseDetail(
        { id: "user-1" },
        {
          appeals: [
            { id: "appeal-1", reason: "It wasn't me", createdAt: new Date(), status: "open" },
          ],
        },
      ),
    );
    await renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
      queryClient,
      signedInAs: { role: "moderator" },
    });

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: m.moderation_case_appeal_overturn() }),
    );

    await waitFor(() =>
      expect(fakeClient.moderation.appealReview).toHaveBeenCalledWith(
        { appealId: "appeal-1", outcome: "overturned", note: undefined },
        expect.anything(),
      ),
    );
  });

  it("hides the review actions once the appeal is no longer open", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.case(
      target,
      makeUserModerationCaseDetail(
        { id: "user-1" },
        {
          appeals: [
            {
              id: "appeal-1",
              reason: "It wasn't me",
              createdAt: new Date(),
              status: "overturned",
            },
          ],
        },
      ),
    );
    await renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
      queryClient,
      signedInAs: { role: "moderator" },
    });

    expect(await screen.findByText(m.moderation_appeal_status_overturned())).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: m.moderation_case_appeal_overturn() }),
    ).not.toBeInTheDocument();
  });
});

describe("CaseDialog — two open appeals on one case", () => {
  // Two control families can be appealed against one target at once (a ban
  // and a role change), so the dialog renders two review sections. Each needs
  // its own note draft and its own mutation state — a shared slot would submit
  // whichever text was typed last with whichever decision was clicked first,
  // and light both sections' success alerts off one review.
  const target: CaseRef = { targetType: "user", targetId: "user-1" };

  async function renderTwoOpenAppeals() {
    fakeClient.moderation.appealReview.mockResolvedValue({
      appealId: "appeal-1",
      status: "upheld",
    });
    const detail = makeUserModerationCaseDetail(
      { id: "user-1" },
      {
        appeals: [
          { id: "appeal-1", reason: "The ban was unfair", createdAt: new Date(), status: "open" },
          { id: "appeal-2", reason: "The role was mine", createdAt: new Date(), status: "open" },
        ],
      },
    );
    // A recorded review invalidates the case query; the refetch must resolve
    // to the same detail so the success alert survives the sweep it triggers.
    fakeClient.moderation.case.mockResolvedValue(detail);
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.case(target, detail);
    return renderWithProviders(<CaseDialog target={target} onClose={() => {}} />, {
      queryClient,
      signedInAs: { role: "moderator" },
    });
  }

  it("renders two independent note fields with unique ids", async () => {
    await renderTwoOpenAppeals();

    const noteFields = await screen.findAllByLabelText(m.moderation_case_appeal_note_label());
    expect(noteFields).toHaveLength(2);
    expect(noteFields[0].id).not.toBe(noteFields[1].id);
  });

  it("does not leak a note typed for one appeal into the other's draft", async () => {
    await renderTwoOpenAppeals();

    const user = userEvent.setup();
    const noteFields = await screen.findAllByLabelText(m.moderation_case_appeal_note_label());
    await user.type(noteFields[0], "the ban was excessive");

    expect(noteFields[0]).toHaveValue("the ban was excessive");
    expect(noteFields[1]).toHaveValue("");
  });

  it("submits each section's own note with its own appeal id", async () => {
    await renderTwoOpenAppeals();

    const user = userEvent.setup();
    const noteFields = await screen.findAllByLabelText(m.moderation_case_appeal_note_label());
    await user.type(noteFields[1], "granted back then");
    // DOM order matches the `appeals` array (rendered newest-first upstream),
    // so the second section is appeal-2.
    const overturnButtons = await screen.findAllByRole("button", {
      name: m.moderation_case_appeal_overturn(),
    });
    await user.click(overturnButtons[1]);

    await waitFor(() =>
      expect(fakeClient.moderation.appealReview).toHaveBeenCalledWith(
        { appealId: "appeal-2", outcome: "overturned", note: "granted back then" },
        expect.anything(),
      ),
    );
  });

  it("marks only the reviewed appeal as done", async () => {
    await renderTwoOpenAppeals();

    const user = userEvent.setup();
    const overturnButtons = await screen.findAllByRole("button", {
      name: m.moderation_case_appeal_overturn(),
    });
    await user.click(overturnButtons[0]);

    await waitFor(() =>
      expect(fakeClient.moderation.appealReview).toHaveBeenCalledWith(
        { appealId: "appeal-1", outcome: "overturned", note: undefined },
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(screen.getAllByText(m.moderation_case_appeal_done())).toHaveLength(1),
    );
  });
});
