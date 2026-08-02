import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { SegmentedControl, SegmentedControlItem } from "@/components/segmented-control";

function Fixture({ active, onChange }: { active: "for-you" | "following"; onChange: (next: "for-you" | "following") => void }) {
  return (
    <SegmentedControl label="Feed">
      <SegmentedControlItem active={active === "for-you"} onClick={() => onChange("for-you")}>
        For you
      </SegmentedControlItem>
      <SegmentedControlItem active={active === "following"} onClick={() => onChange("following")}>
        Following
      </SegmentedControlItem>
    </SegmentedControl>
  );
}

describe("SegmentedControl", () => {
  it("exposes the group and each option's selected state accessibly", async () => {
    await renderWithProviders(<Fixture active="for-you" onChange={() => {}} />);

    // `role="group"` + `aria-label` names the whole control; each option is
    // a toggle button whose `aria-pressed` — not just its styling — is what
    // communicates which one is selected.
    const group = screen.getByRole("group", { name: "Feed" });
    expect(group).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "For you" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Following" })).toHaveAttribute("aria-pressed", "false");
  });

  it("invokes the change handler with the clicked option's value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    await renderWithProviders(<Fixture active="for-you" onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Following" }));

    expect(onChange).toHaveBeenCalledWith("following");
  });

  it("is keyboard operable — Enter and Space both activate the focused option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    await renderWithProviders(<Fixture active="for-you" onChange={onChange} />);

    await user.tab(); // focuses the first button ("For you")
    await user.tab(); // focuses the second button ("Following")
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("following");

    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith("following");
  });
});
