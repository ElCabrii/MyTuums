import { beforeEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { NotFoundPage } from "@/components/not-found-page";
import { m } from "@/paraglide/messages.js";

beforeEach(() => {
  document.head.querySelector('meta[name="description"]')?.remove();
  const description = document.createElement("meta");
  description.setAttribute("name", "description");
  document.head.appendChild(description);
});

describe("NotFoundPage", () => {
  it("renders the title and body", async () => {
    await renderWithProviders(<NotFoundPage />);

    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("This page doesn't exist or has moved.")).toBeInTheDocument();
    expect(document.title).toBe(`${m.notfound_title()} - ${m.app_title_suffix()}`);
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute(
      "content",
      m.app_document_description(),
    );
  });

  it("back-home button navigates to /", async () => {
    const user = userEvent.setup();
    const { router } = await renderWithProviders(<NotFoundPage />);

    await user.click(screen.getByRole("button", { name: "Back to home" }));

    expect(router.state.location.pathname).toBe("/");
  });
});
