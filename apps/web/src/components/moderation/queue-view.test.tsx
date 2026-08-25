import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createTestQueryClient,
  makeModerationCase,
  makeModerationCaseDetail,
  makePostPreview,
  makeUserPreview,
  queryFixtures,
  renderWithProviders,
} from "@/test/render";
import { QueueView } from "@/components/moderation/queue-view";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

// None of these are actually invoked in this file — the row-click test only
// opens the dialog, it never clicks an action — but `CaseBody` reads every
// mutation atom unconditionally on mount (`useAtomValue`, not lazily), and
// `createTanstackQueryUtils`'s proxy indexes into the fake client one path
// segment at a time, so a missing segment throws before mount even finishes
// (see case-dialog.test.tsx's fuller version of this comment).
const fakeClient = {
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
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QueueView", () => {
  it("shows an open appeal with a badge, and a report count in the right plural form", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.queue([
      {
        items: [
          makeModerationCase({
            targetType: "post",
            targetId: "post-1",
            reportCount: 3,
            reasons: ["spam"],
            appeals: [{ id: "appeal-1", reason: "wasn't spam", createdAt: new Date() }],
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
    queryFixtures(queryClient).moderation.queue([
      {
        items: [
          makeModerationCase({
            targetType: "user",
            targetId: "user-1",
            reportCount: 1,
            reasons: ["harassment"],
            appeals: [],
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

  it("counts what is loaded, and badges the appeals among it", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.queue([
      {
        items: [
          makeModerationCase({ targetId: "post-1", appeals: [] }),
          makeModerationCase({
            targetId: "post-2",
            appeals: [{ id: "appeal-1", reason: "not spam", createdAt: new Date() }],
          }),
          makeModerationCase({ targetId: "post-3", appeals: [] }),
        ],
        nextCursor: null,
      },
    ]);
    await renderWithProviders(<QueueView />, { queryClient, signedInAs: { role: "moderator" } });

    expect(
      await screen.findByText(m.moderation_queue_open_many({ count: "3" })),
    ).toBeInTheDocument();
    // One of the three carries an appeal — the appeal badge counts cases, not
    // reports, so a page of three with one appeal reads "1 appeal".
    expect(screen.getByText(m.moderation_queue_appeals_one({ count: "1" }))).toBeInTheDocument();
  });

  it("marks the count as partial while the server still has a page behind the cursor", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.queue([
      { items: [makeModerationCase({ targetId: "post-1" })], nextCursor: "cursor-1" },
    ]);
    await renderWithProviders(<QueueView />, { queryClient, signedInAs: { role: "moderator" } });

    // "1+", never "1": one case is loaded and the cursor proves there are more,
    // so the singular form would claim a total the server never sent.
    expect(
      await screen.findByText(m.moderation_queue_open_many({ count: "1+" })),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(m.moderation_queue_appeals_one({ count: "1" })),
    ).not.toBeInTheDocument();
  });

  it("names the reported post's author and shows its excerpt, ellipsised only when the server cut it", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.queue([
      {
        items: [
          makeModerationCase({
            targetId: "post-1",
            preview: makePostPreview({
              excerpt: "a very long body the server cut",
              truncated: true,
              author: {
                id: "author-1",
                name: "Alex Mercer",
                username: "alexmercer",
                displayUsername: "AlexMercer",
                image: null,
              },
            }),
          }),
        ],
        nextCursor: null,
      },
    ]);
    await renderWithProviders(<QueueView />, { queryClient, signedInAs: { role: "moderator" } });

    expect(await screen.findByText("Alex Mercer")).toBeInTheDocument();
    expect(screen.getByText(/@alexmercer/)).toBeInTheDocument();
    // The ellipsis is the client's, drawn only because the server said it
    // truncated — the excerpt itself never carries one.
    expect(screen.getByText(/a very long body the server cut…/)).toBeInTheDocument();
  });

  it("drops the excerpt segment entirely for an image-only post whose content is ''", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.queue([
      {
        items: [
          makeModerationCase({
            targetId: "post-1",
            preview: makePostPreview({ excerpt: "", truncated: false }),
          }),
        ],
        nextCursor: null,
      },
    ]);
    const { container } = await renderWithProviders(<QueueView />, {
      queryClient,
      signedInAs: { role: "moderator" },
    });

    expect(await screen.findByText("Alex Mercer")).toBeInTheDocument();
    // The author line renders, but without a dangling " — " for the missing
    // text (issue #202).
    expect(container.textContent).not.toContain("—");
  });

  it("renders a post preview's attachments as thumbnails, so an image report is visible without opening the case", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.queue([
      {
        items: [
          makeModerationCase({
            targetId: "post-1",
            preview: makePostPreview({
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
          }),
        ],
        nextCursor: null,
      },
    ]);
    await renderWithProviders(<QueueView />, { queryClient, signedInAs: { role: "moderator" } });

    expect(await screen.findByText("Alex Mercer")).toBeInTheDocument();
    // The compact grid renders a thumbnail per attachment; the case dialog's
    // full grid is what a click through the row opens.
    expect(screen.getByAltText(m.post_attachment_alt({ position: "1" }))).toBeInTheDocument();
  });

  it("badges what has already happened to the target: a removed reply, a suspension, a permanent ban", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.queue([
      {
        items: [
          makeModerationCase({
            targetId: "post-1",
            preview: makePostPreview({ isReply: true, removed: true }),
          }),
          makeModerationCase({
            targetType: "user",
            targetId: "user-1",
            preview: makeUserPreview({ banned: true, banExpires: new Date("2027-01-01") }),
          }),
          makeModerationCase({
            targetType: "user",
            targetId: "user-2",
            preview: makeUserPreview({ banned: true, banExpires: null }),
          }),
        ],
        nextCursor: null,
      },
    ]);
    await renderWithProviders(<QueueView />, { queryClient, signedInAs: { role: "moderator" } });

    expect(await screen.findByText(m.moderation_case_reply_badge())).toBeInTheDocument();
    expect(screen.getByText(m.moderation_case_removed_badge())).toBeInTheDocument();
    // `banExpires` is the only thing separating the two sentences.
    expect(screen.getByText(m.moderation_queue_suspended_badge())).toBeInTheDocument();
    expect(screen.getByText(m.moderation_case_banned_badge())).toBeInTheDocument();
  });

  it("still renders a case whose target row is gone, saying so instead of naming nobody", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.queue([
      { items: [makeModerationCase({ targetId: "post-1", preview: null })], nextCursor: null },
    ]);
    await renderWithProviders(<QueueView />, { queryClient, signedInAs: { role: "moderator" } });

    expect(await screen.findByText(m.moderation_queue_target_gone())).toBeInTheDocument();
    // The case is still openable — the reports outlived their target and are
    // what a moderator has to close.
    expect(screen.getByRole("button", { name: /Spam/ })).toBeInTheDocument();
  });

  it("opens the case dialog for the clicked row's exact target", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).moderation.queue([
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
    queryFixtures(queryClient).moderation.case(
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
