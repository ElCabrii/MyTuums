import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { UserX } from "lucide-react";
import { renderWithProviders } from "@/test/render";
import { ProfileMessage } from "@/components/profile-message";

describe("ProfileMessage", () => {
  it("renders the supplied icon, heading and explanatory content", async () => {
    const { container } = await renderWithProviders(
      <ProfileMessage icon={UserX} title="Unavailable profile">
        <p>The requested account cannot be shown.</p>
      </ProfileMessage>,
    );

    expect(screen.getByRole("heading", { name: "Unavailable profile" })).toBeInTheDocument();
    expect(screen.getByText("The requested account cannot be shown.")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
