import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { BannedPage } from "@/components/banned-page";

describe("BannedPage", () => {
  it("renders the localized title and body", async () => {
    await renderWithProviders(<BannedPage />);

    expect(screen.getByRole("heading", { name: "Account banned" })).toBeInTheDocument();
    expect(screen.getByText(/Your MyTuums account has been banned/)).toBeInTheDocument();
  });
});
