import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { POST_REPORT_REASONS, USER_REPORT_REASONS } from "@my-tuums/api/constants";
import { reportDialogAtom, reportReasonAtom, type CaseRef } from "@/atoms/moderation";
import { renderWithProviders } from "@/test/render";
import { ReportDialog } from "@/components/moderation/report-dialog";
import { reasonLabel } from "@/components/moderation/labels";
import { m } from "@/paraglide/messages.js";

const { fakeClient } = vi.hoisted(() => ({
  fakeClient: {
    moderation: {
      report: vi.fn(),
      // A successful report's `onSuccess` sweeps these three via
      // `invalidateModerationQueries` (`atoms/moderation.ts`) — unstubbed,
      // the fake client's proxy throws reading a property off `undefined`
      // while building `.key()` (see case-dialog.test.tsx's fuller comment),
      // which the mutation machinery reports back as the mutation itself
      // having failed. The "success" test below needs these to actually
      // observe success.
      queue: vi.fn(),
      case: vi.fn(),
      auditLog: vi.fn(),
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

/**
 * Opens the dialog on a target the way the kebab menu does: setting the
 * identity atom before render, since `ReportDialog`'s `open` is driven
 * straight off it (no click-to-open step exists inside this component).
 */
async function openReportDialog(target: CaseRef) {
  const store = createStore();
  store.set(reportDialogAtom, target);
  const result = await renderWithProviders(<ReportDialog />, { store });
  return { ...result, store };
}

describe("ReportDialog", () => {
  it("keeps Report disabled until a reason is picked, then submits the post target", async () => {
    fakeClient.moderation.report.mockResolvedValue({ reported: true });
    const { store } = await openReportDialog({ targetType: "post", targetId: "post-1" });

    const submit = await screen.findByRole("button", { name: m.moderation_report_submit() });
    expect(submit).toBeDisabled();

    // The reason picker is base-ui's floating Select — driven the same way
    // team-view.test.tsx drives its role picker: the atom `onValueChange`
    // would set, asserting the dialog's reaction rather than the gesture.
    act(() => store.set(reportReasonAtom, "spam"));
    expect(submit).toBeEnabled();

    const user = userEvent.setup();
    await user.click(submit);

    await waitFor(() =>
      expect(fakeClient.moderation.report).toHaveBeenCalledWith(
        { targetType: "post", targetId: "post-1", reason: "spam" },
        expect.anything(),
      ),
    );
  });

  it("submits the user target with a user-only reason code", async () => {
    fakeClient.moderation.report.mockResolvedValue({ reported: true });
    const { store } = await openReportDialog({ targetType: "user", targetId: "user-1" });

    act(() => store.set(reportReasonAtom, "impersonation"));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.moderation_report_submit() }));

    await waitFor(() =>
      expect(fakeClient.moderation.report).toHaveBeenCalledWith(
        { targetType: "user", targetId: "user-1", reason: "impersonation" },
        expect.anything(),
      ),
    );
  });

  it("offers USER_REPORT_REASONS and the user-target title for a user target", async () => {
    // Both reason tests above bypass this picker (`act(() => store.set(...))`),
    // so they'd stay green even if `report-dialog.tsx`'s target-type branch
    // (line 63) always returned POST_REPORT_REASONS — this is the one place
    // that actually looks at what the reporter is offered.
    await openReportDialog({ targetType: "user", targetId: "user-1" });

    expect(
      await screen.findByRole("heading", { name: m.moderation_report_title_user() }),
    ).toBeInTheDocument();
    const listbox = await screen.findByRole("listbox", { hidden: true });
    expect(
      within(listbox)
        .getAllByRole("option", { hidden: true })
        .map((option) => option.textContent),
    ).toEqual(USER_REPORT_REASONS.map((code) => reasonLabel(code)));
  });

  it("offers POST_REPORT_REASONS and the post-target title for a post target", async () => {
    await openReportDialog({ targetType: "post", targetId: "post-1" });

    expect(
      await screen.findByRole("heading", { name: m.moderation_report_title_post() }),
    ).toBeInTheDocument();
    const listbox = await screen.findByRole("listbox", { hidden: true });
    expect(
      within(listbox)
        .getAllByRole("option", { hidden: true })
        .map((option) => option.textContent),
    ).toEqual(POST_REPORT_REASONS.map((code) => reasonLabel(code)));
  });

  it("shows the thank-you copy and hides the submit button once the report succeeds", async () => {
    fakeClient.moderation.report.mockResolvedValue({ reported: true });
    const { store } = await openReportDialog({ targetType: "post", targetId: "post-1" });

    act(() => store.set(reportReasonAtom, "spam"));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.moderation_report_submit() }));

    expect(await screen.findByText(m.moderation_report_done())).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: m.moderation_report_submit() }),
    ).not.toBeInTheDocument();
  });

  it("shows an error and keeps the form open when the report fails", async () => {
    fakeClient.moderation.report.mockRejectedValue(new Error("network down"));
    const { store } = await openReportDialog({ targetType: "post", targetId: "post-1" });

    act(() => store.set(reportReasonAtom, "spam"));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.moderation_report_submit() }));

    expect(await screen.findByRole("alert")).toHaveTextContent(m.moderation_report_error());
    // Unlike success, failure keeps the submit control around for a retry.
    expect(screen.getByRole("button", { name: m.moderation_report_submit() })).toBeInTheDocument();
  });
});
