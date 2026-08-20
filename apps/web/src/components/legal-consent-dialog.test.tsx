import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";
import { renderWithProviders } from "@/test/render";
import { patchTestSessionUser } from "@/test/auth-fixture";
import { authClient } from "@/lib/auth-client";
import { LegalConsentDialog } from "@/components/legal-consent-dialog";
import { m } from "@/paraglide/messages.js";

/**
 * The atom-level cases (which sessions require consent, what the save writes)
 * live in atoms/legal-consent.test.ts. What only rendering can prove is here:
 * the gate is actually on screen for a stale session, the documents stay
 * reachable from behind an undismissable modal, and accepting takes it down.
 */
describe("LegalConsentDialog", () => {
  const staleViewer = {
    legalAcceptedAt: new Date("2020-01-01T00:00:00.000Z"),
    legalVersion: "2020-01-01",
  };

  it("stays out of the way of an account whose consent is current", async () => {
    await renderWithProviders(<LegalConsentDialog />, {
      signedInAs: { legalAcceptedAt: new Date(), legalVersion: LEGAL_VERSION },
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("holds a never-accepted account with the first-time copy", async () => {
    await renderWithProviders(<LegalConsentDialog />, {
      signedInAs: { legalAcceptedAt: null, legalVersion: null },
    });

    expect(
      await screen.findByRole("heading", { name: m.legal_consent_missing_title() }),
    ).toBeInTheDocument();
  });

  it("tells a stale account the documents changed, and links both out to a new tab", async () => {
    await renderWithProviders(<LegalConsentDialog />, { signedInAs: staleViewer });

    expect(
      await screen.findByRole("heading", { name: m.legal_consent_update_title() }),
    ).toBeInTheDocument();

    // The dialog cannot be dismissed, so an in-page navigation would strand
    // the reader away from the documents it is asking them to accept.
    for (const [name, href] of [
      [m.legal_terms_of_service(), "/terms"],
      [m.legal_privacy_policy(), "/privacy"],
    ]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
    }
  });

  it.each(["/terms", "/privacy", "/mentions-legales"])(
    "stands down on %s so the documents stay readable behind the gate",
    async (initialPath) => {
      await renderWithProviders(<LegalConsentDialog />, {
        signedInAs: { legalAcceptedAt: null, legalVersion: null },
        initialPath,
      });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("keeps Accept disabled until the box is ticked, then records consent and closes", async () => {
    await renderWithProviders(<LegalConsentDialog />, { signedInAs: staleViewer });
    const user = userEvent.setup();

    const accept = await screen.findByRole("button", { name: m.legal_consent_accept() });
    expect(accept).toBeDisabled();

    vi.mocked(authClient.updateUser).mockImplementation(() => {
      patchTestSessionUser({ legalAcceptedAt: new Date(), legalVersion: LEGAL_VERSION });
      return Promise.resolve({ data: {}, error: null });
    });

    await user.click(screen.getByRole("checkbox"));
    expect(accept).toBeEnabled();
    await user.click(accept);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the gate up and reports a failed save", async () => {
    await renderWithProviders(<LegalConsentDialog />, { signedInAs: staleViewer });
    const user = userEvent.setup();

    vi.mocked(authClient.updateUser).mockResolvedValue({
      data: null,
      error: { message: "Could not save consent." },
    });

    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: m.legal_consent_accept() }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save consent.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
