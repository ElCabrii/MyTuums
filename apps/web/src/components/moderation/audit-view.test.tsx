import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import {
  createTestQueryClient,
  makeAuditEntry,
  renderWithProviders,
  seedAuditLogPages,
} from "@/test/render";
import { AuditView } from "@/components/moderation/audit-view";
import { m } from "@/paraglide/messages.js";

/**
 * Pure query component — no mutation buttons here, so unlike the rest of the
 * moderation views this file needs no `@/lib/orpc` fake client: the audit
 * log is always seeded straight into the cache, and `refetchOnMount: false`
 * (see `test/render.tsx`) means it's never actually fetched.
 */
describe("AuditView", () => {
  it("renders an actioned entry with its actor and target", async () => {
    const queryClient = createTestQueryClient();
    seedAuditLogPages(queryClient, [
      {
        items: [
          makeAuditEntry({
            action: "user_banned",
            reason: "repeat harassment",
            actor: {
              id: "mod-1",
              name: "Sam Moderator",
              username: "sammod",
              displayUsername: "SamMod",
              image: null,
            },
            targetUser: {
              id: "user-1",
              name: "Bad Actor",
              username: "badactor",
              displayUsername: "BadActor",
              image: null,
            },
          }),
        ],
        nextCursor: null,
      },
    ]);
    await renderWithProviders(<AuditView />, { queryClient, signedInAs: { role: "staff" } });

    expect(await screen.findByText(m.moderation_action_user_banned())).toBeInTheDocument();
    expect(screen.getByText("repeat harassment")).toBeInTheDocument();
    expect(screen.getByText("Sam Moderator")).toBeInTheDocument();
    expect(screen.getByText("Bad Actor")).toBeInTheDocument();
    expect(screen.getByText("@sammod")).toBeInTheDocument();
    expect(screen.getByText("@badactor")).toBeInTheDocument();
  });

  it("renders a system actor and a post target as the dash and the truncated post id", async () => {
    const queryClient = createTestQueryClient();
    seedAuditLogPages(queryClient, [
      {
        items: [
          makeAuditEntry({
            action: "post_restored",
            actorId: null,
            actor: null,
            targetType: "post",
            targetPostId: "0123456789abcdef0123456789abcdef",
            targetUserId: null,
            targetUser: null,
          }),
        ],
        nextCursor: null,
      },
    ]);
    await renderWithProviders(<AuditView />, { queryClient, signedInAs: { role: "staff" } });

    expect(await screen.findByText(m.moderation_action_post_restored())).toBeInTheDocument();
    // The actor cell reads "—" for a null actor (a deleted account, or a
    // system-triggered action); the target cell reads the post id's first 8
    // characters rather than "—", since a post id IS on the row.
    expect(screen.getByText(m.moderation_audit_none())).toBeInTheDocument();
    expect(
      screen.getByText(
        m.moderation_audit_post({ id: "0123456789abcdef0123456789abcdef".slice(0, 8) }),
      ),
    ).toBeInTheDocument();
  });

  it("renders the empty state when the log has no entries", async () => {
    const queryClient = createTestQueryClient();
    seedAuditLogPages(queryClient, [{ items: [], nextCursor: null }]);
    await renderWithProviders(<AuditView />, { queryClient, signedInAs: { role: "staff" } });

    expect(await screen.findByText(m.moderation_audit_empty())).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
