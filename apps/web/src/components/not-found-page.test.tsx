import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { NotFoundPage } from "@/components/not-found-page";

describe("NotFoundPage", () => {
  it("renders the title and body", async () => {
    await renderWithProviders(<NotFoundPage />);

    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("This page doesn't exist or has moved.")).toBeInTheDocument();
  });

  it("back-home button navigates to /", async () => {
    const user = userEvent.setup();
    const { router } = await renderWithProviders(<NotFoundPage />);

    await user.click(screen.getByRole("button", { name: "Back to home" }));

    expect(router.state.location.pathname).toBe("/");
  });
});
