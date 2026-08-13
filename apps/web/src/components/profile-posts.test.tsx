import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  createTestQueryClient,
  makeProfile,
  renderWithProviders,
  queryFixtures,
} from "@/test/render";
import { ProfilePosts } from "@/components/profile-posts";
import { m } from "@/paraglide/messages.js";

const { fakeClient } = vi.hoisted(() => ({
  fakeClient: {
    user: { byUsername: vi.fn() },
    post: { list: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/orpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orpc")>();
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { ...actual, orpc: createTanstackQueryUtils(fakeClient) };
});

describe("ProfilePosts", () => {
  it("shows the composer and owner-specific empty copy on the viewer's profile", async () => {
    const profile = makeProfile({ id: "viewer-1", username: "alex", displayUsername: "Alex" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("alex", profile);
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null }], {
      authorId: profile.id,
      feed: "global",
      includeReplies: true,
    });

    await renderWithProviders(<ProfilePosts />, {
      queryClient,
      initialPath: "/@alex/",
      signedInAs: { id: profile.id, username: "alex" },
    });

    expect(screen.getByPlaceholderText(m.post_placeholder())).toBeInTheDocument();
    expect(screen.getByText(m.profile_own_empty())).toBeInTheDocument();
    expect(fakeClient.post.list).not.toHaveBeenCalled();
  });

  it("hides the composer and uses handle-specific copy for another profile", async () => {
    const profile = makeProfile({ id: "other-1", username: "other", displayUsername: "Other" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("other", profile);
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null }], {
      authorId: profile.id,
      feed: "global",
      includeReplies: true,
    });

    await renderWithProviders(<ProfilePosts />, {
      queryClient,
      initialPath: "/@other/",
      signedInAs: { id: "viewer-1" },
    });

    expect(screen.queryByPlaceholderText(m.post_placeholder())).not.toBeInTheDocument();
    expect(screen.getByText(m.profile_empty({ handle: "other" }))).toBeInTheDocument();
    expect(fakeClient.post.list).not.toHaveBeenCalled();
  });
});
