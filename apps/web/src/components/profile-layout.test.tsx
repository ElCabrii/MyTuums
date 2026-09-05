import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { ORPCError } from "@orpc/client";
import { blockDialogAtom, reportDialogAtom } from "@/atoms/moderation";
import { createTestQueryClient, makeProfile } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { ProfileLayout } from "@/components/profile-layout";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = {
  user: {
    byUsername: vi.fn(),
    follow: vi.fn(),
    unfollow: vi.fn(),
  },
  moderation: { unbanUser: vi.fn() },
  // The favorites rail the layout now renders reads through this group; an
  // empty answer keeps the rail hidden in every profile test here.
  game: { favorites: vi.fn().mockResolvedValue({ items: [] }) },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
  document.head.querySelector('meta[name="description"]')?.remove();
  const description = document.createElement("meta");
  description.setAttribute("name", "description");
  document.head.appendChild(description);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProfileLayout query states", () => {
  it("renders only the loading shell while the profile is pending", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.loading("pending");

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@pending",
      signedInAs: true,
    });

    expect(screen.queryByRole("heading", { name: "@pending" })).not.toBeInTheDocument();
    expect(fakeClient.user.byUsername).not.toHaveBeenCalled();
  });

  it("renders the not-found stub for a missing handle", async () => {
    const queryClient = createTestQueryClient();
    await queryFixtures(queryClient).profile.error("missing", new ORPCError("NOT_FOUND"));

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@missing",
      signedInAs: true,
    });

    expect(screen.getByRole("heading", { name: "@missing" })).toBeInTheDocument();
    expect(screen.getByText(m.profile_not_found())).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.common_try_again() })).not.toBeInTheDocument();
  });

  it("retries a transient error and replaces the error card with the profile", async () => {
    const recovered = makeProfile({
      name: "Recovered",
      username: "recovered",
      displayUsername: "Recovered",
    });
    fakeClient.user.byUsername.mockResolvedValue(recovered);
    const queryClient = createTestQueryClient();
    await queryFixtures(queryClient).profile.error("recovered", new Error("temporary failure"));
    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@recovered",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.common_try_again() }));

    expect(await screen.findByRole("heading", { name: "Recovered" })).toBeInTheDocument();
    await waitFor(() =>
      expect(fakeClient.user.byUsername).toHaveBeenCalledWith(
        { username: "recovered" },
        expect.anything(),
      ),
    );
  });
});

describe("ProfileLayout role and ownership gates", () => {
  it("renders the profile's badges beside the display name", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data(
      "badged",
      makeProfile({
        username: "badged",
        displayUsername: "Badged",
        name: "Badged Person",
        badges: ["popular", "founder"],
      }),
    );

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@badged",
      signedInAs: true,
    });

    expect(screen.getByRole("heading", { name: "Badged Person" })).toBeInTheDocument();
    expect(screen.getByTitle(m.badge_popular())).toBeInTheDocument();
    expect(screen.getByTitle(m.badge_founder())).toBeInTheDocument();
  });

  it("renders locked counts as plain numbers with no list dialog for non-followers", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data(
      "locked",
      makeProfile({
        username: "locked",
        displayUsername: "Locked",
        isPrivate: true,
        followerCount: 5,
        followingCount: 3,
      }),
    );

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@locked",
      signedInAs: true,
    });

    // The counts read as text (issue #328) — no dialog trigger wraps them, so
    // a non-follower can never open a list the server would only return empty.
    expect(screen.getByText(m.follow_followers()).closest("button")).toBeNull();
    expect(screen.getByText(m.follow_following()).closest("button")).toBeNull();
  });

  it("renders no badges on the suspended stub", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data(
      "suspbadged",
      makeProfile({
        username: "suspbadged",
        displayUsername: "SuspBadged",
        suspended: true,
        badges: ["founder"],
      }),
    );

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@suspbadged",
      signedInAs: true,
    });

    // Authored-field redaction applies to badges like everything else
    // (issue #308) — and the stub page never renders the header row at all.
    expect(screen.getByText(m.profile_suspended_body())).toBeInTheDocument();
    expect(screen.queryByTitle(m.badge_founder())).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: m.profile_badges_label() })).not.toBeInTheDocument();
  });

  it("shows a suspended stub but no unban action to a plain user", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data(
      "suspended",
      makeProfile({ username: "suspended", displayUsername: "Suspended", suspended: true }),
    );

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@suspended",
      signedInAs: { role: "user" },
    });

    expect(screen.getByText(m.profile_suspended_body())).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "@suspended" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.moderation_unban() })).not.toBeInTheDocument();
  });

  it("lets staff unban a suspended profile", async () => {
    const suspended = makeProfile({
      id: "suspended-1",
      username: "suspended",
      displayUsername: "Suspended",
      suspended: true,
    });
    const recovered = makeProfile({ ...suspended, suspended: false });
    fakeClient.moderation.unbanUser.mockResolvedValue({ userId: suspended.id, unbanned: true });
    fakeClient.user.byUsername.mockResolvedValue(recovered);
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("suspended", suspended);
    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@suspended",
      signedInAs: { role: "staff" },
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.moderation_unban() }));

    await waitFor(() =>
      expect(fakeClient.moderation.unbanUser).toHaveBeenCalledWith(
        { userId: suspended.id },
        expect.anything(),
      ),
    );
  });

  it("shows settings, and no sign-out, on the viewer's own profile", async () => {
    const own = makeProfile({ id: "viewer-1", username: "alex", displayUsername: "Alex" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("alex", own);

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@alex",
      signedInAs: { id: own.id, username: "alex", email: "owner@example.com" },
    });

    expect(screen.getByRole("button", { name: m.profile_settings() })).toBeInTheDocument();
    // Sign-out has no surface on the profile page (issue #282): the navbar
    // account menu is the always-visible affordance, and /settings/account
    // carries the card. The click paths themselves stay pinned in
    // header.test.tsx and use-sign-out.test.tsx.
    expect(screen.queryByRole("button", { name: m.auth_sign_out() })).not.toBeInTheDocument();
    // The profile header renders no email — not even the owner's own. The
    // address belongs to Settings, and showing it here read like leakage
    // (issue #208).
    expect(screen.queryByText("owner@example.com")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(m.moderation_kebab())).not.toBeInTheDocument();
  });

  it("shows follow, report and block controls for another profile", async () => {
    const other = makeProfile({ id: "other-1", username: "other", displayUsername: "Other" });
    const store = createStore();
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("other", other);
    await renderWithProviders(<ProfileLayout />, {
      store,
      queryClient,
      initialPath: "/@other",
      signedInAs: { id: "viewer-1" },
    });
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: m.follow_action() })).toBeInTheDocument();
    await user.click(screen.getByLabelText(m.moderation_kebab()));
    await user.click(
      await screen.findByRole("menuitem", { name: m.moderation_kebab_report_author() }),
    );
    expect(store.get(reportDialogAtom)).toEqual({ targetType: "user", targetId: other.id });

    await user.click(screen.getByLabelText(m.moderation_kebab()));
    await user.click(await screen.findByRole("menuitem", { name: m.moderation_kebab_block() }));
    expect(store.get(blockDialogAtom)).toEqual({ userId: other.id, handle: "other" });
  });
});

describe("ProfileLayout bio", () => {
  it("uses the canonical returned handle in the document title", async () => {
    const bio = "A profile bio for search previews.";
    const profile = makeProfile({
      username: "canonical",
      displayUsername: "Canonical",
      bio,
    });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("CANONICAL", profile);

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@CANONICAL",
      signedInAs: true,
    });

    await waitFor(() => {
      expect(document.title).toBe(`@canonical - ${m.app_title_suffix()}`);
      expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute(
        "content",
        bio,
      );
    });
  });

  it("does not publish a suspended profile bio in document metadata", async () => {
    const privateBio = "This suspended bio must not reach page metadata.";
    const profile = makeProfile({
      username: "suspended",
      displayUsername: "Suspended",
      bio: privateBio,
      suspended: true,
    });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("suspended", profile);

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@suspended",
      signedInAs: true,
    });

    await waitFor(() => {
      expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute(
        "content",
        m.app_document_description(),
      );
    });
    expect(document.head.querySelector('meta[name="description"]')).not.toHaveAttribute(
      "content",
      privateBio,
    );
  });
});

describe("ProfileLayout banner", () => {
  it("renders the encoded 3:1 composition in a height-clamped frame", async () => {
    const profile = makeProfile({
      name: "Banner Owner",
      username: "banner-owner",
      bannerImage: "/media/banner-owner.webp",
    });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("banner-owner", profile);

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@banner-owner",
      signedInAs: true,
    });

    const banner = screen.getByRole("img", {
      name: m.profile_banner_alt({ name: profile.name }),
    });
    // The frame is the canonical 3:1 with its height clamped by the constants
    // in lib/banner-frame.ts: exact 3:1 wherever the measure holds, a 150px
    // band on narrow phones, never taller than 320px on wide monitors.
    expect(banner.parentElement).toHaveStyle({
      aspectRatio: "3",
      maxWidth: "1500px",
      minHeight: "150px",
      maxHeight: "320px",
    });
    expect(banner.parentElement).toHaveClass("mx-auto");
    // Each class needs its own negation: jest-dom's toHaveClass(a, b) requires
    // BOTH, so the negated form would pass if only one of them reappeared.
    expect(banner.parentElement).not.toHaveClass("h-48");
    expect(banner.parentElement).not.toHaveClass("sm:h-64");
  });
});

describe("ProfileLayout avatar viewer", () => {
  it("opens the profile picture and closes it with the dialog action", async () => {
    const profile = makeProfile({
      name: "Picture Owner",
      username: "picture-owner",
      image: "/media/picture-owner.webp",
    });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("picture-owner", profile);

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@picture-owner",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: m.profile_avatar_view({ name: profile.name }) }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(m.profile_avatar_title({ name: profile.name }));
    expect(
      within(dialog).getByRole("img", { name: m.profile_avatar_alt({ name: profile.name }) }),
    ).toHaveAttribute("src", profile.image);

    await user.click(within(dialog).getByRole("button", { name: m.common_close() }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("replaces a broken profile picture with a noninteractive initials fallback", async () => {
    let failImage: (() => void) | undefined;

    class FailingImage {
      complete = false;
      naturalWidth = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        failImage = () => this.onerror?.();
      }
    }

    vi.stubGlobal("Image", FailingImage);
    const profile = makeProfile({
      name: "Picture Owner",
      username: "picture-owner",
      image: "/media/missing.webp",
    });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("picture-owner", profile);

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@picture-owner",
      signedInAs: true,
    });

    expect(
      screen.getByRole("button", { name: m.profile_avatar_view({ name: profile.name }) }),
    ).toBeInTheDocument();
    act(() => failImage?.());

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: m.profile_avatar_view({ name: profile.name }) }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("PO")).toBeInTheDocument();
  });
});
