import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";
import { NotFoundPage } from "@/components/not-found-page";

// The 404 screen's copy and document metadata are static strings — the
// document-head helper they go through is owned by lib/document-head.dom.test.ts
// and its wiring by the pages whose titles actually vary. What only this page
// can get wrong is its one behaviour: offering the way back.
describe("NotFoundPage", () => {
  it("back-home button navigates to /", async () => {
    const user = userEvent.setup();
    const { router } = await renderWithProviders(<NotFoundPage />);

    await user.click(screen.getByRole("button", { name: "Back to home" }));

    expect(router.state.location.pathname).toBe("/");
  });
});
