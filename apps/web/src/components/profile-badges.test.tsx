import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProfileBadges } from "@/components/profile-badges";
import { renderWithProviders } from "@/test/render";
import { m } from "@/paraglide/messages.js";

/**
 * The rendering half of the badge contract (issue #308): the component draws
 * exactly the display set the API returned, in that order — the canonical
 * order itself is the server's contract, pinned in packages/api — and every
 * badge carries its localized name as both the tooltip and the accessible
 * label. The names come from Paraglide keyed by badge id; these tests hold
 * them to the catalogue the server derives from.
 */
describe("ProfileBadges", () => {
  it("renders each badge with its localized name, in the order given", async () => {
    await renderWithProviders(
      <ProfileBadges badges={["supernova", "giant", "founder", "super_early_access"]} />,
    );

    expect(
      screen.getByRole("list", { name: m.profile_badges_label() }).querySelectorAll("li"),
    ).toHaveLength(4);
    // The accessible names, in the canonical order the API returned.
    expect(screen.getAllByRole("img").map((node) => node.getAttribute("aria-label"))).toEqual([
      m.badge_supernova(),
      m.badge_giant(),
      m.badge_founder(),
      m.badge_super_early_access(),
    ]);
    // The tooltip name matches the label — hover and screen reader agree.
    expect(screen.getByTitle(m.badge_founder())).toHaveAttribute("role", "img");
  });

  it("renders every badge id in the catalogue — a name and an icon exist for each", async () => {
    await renderWithProviders(
      <ProfileBadges
        badges={[
          "popular",
          "rising_star",
          "star",
          "superstar",
          "supernova",
          "noticed",
          "trendy",
          "big",
          "exploding",
          "giant",
          "founder",
          "super_early_access",
          "early_access",
        ]}
      />,
    );

    const labelled = screen.getAllByRole("img").map((node) => node.getAttribute("aria-label"));
    expect(labelled).toEqual([
      m.badge_popular(),
      m.badge_rising_star(),
      m.badge_star(),
      m.badge_superstar(),
      m.badge_supernova(),
      m.badge_noticed(),
      m.badge_trendy(),
      m.badge_big(),
      m.badge_exploding(),
      m.badge_giant(),
      m.badge_founder(),
      m.badge_super_early_access(),
      m.badge_early_access(),
    ]);
  });

  it("renders nothing for a profile with no badges", async () => {
    const { container } = await renderWithProviders(<ProfileBadges badges={[]} />);

    expect(container.querySelector("ul")).toBeNull();
  });
});
