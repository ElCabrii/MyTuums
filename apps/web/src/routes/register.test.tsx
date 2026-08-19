import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RegisterPage } from "@/routes/register";
import { authClient } from "@/lib/auth-client";
import { m } from "@/paraglide/messages.js";

/**
 * The E2E specs locate this box by its accessible name (`/I have read and
 * agree/` in `e2e/tests/specs/auth.spec.ts` and in the two `signUpFresh`
 * helpers), so copy reworded without updating them would break Playwright.
 * Asserting the name here fails first, in the suite that runs on every push.
 *
 * Substrings rather than the whole name on purpose: the name is what the
 * accessible-name computation makes of the label span, which joins text from
 * separate elements with a space — so the trailing `auth_register_terms_after`
 * period arrives as " ." and the full string would pin that quirk rather than
 * the copy. `stringContaining` also keeps punctuation in the messages from
 * being read as regex metacharacters.
 */
const termsNameParts = [
  m.auth_register_terms_before().trim(),
  m.legal_terms_of_service(),
  m.legal_privacy_policy(),
];

describe("RegisterPage — Terms & Privacy acceptance (issue #153)", () => {
  it("blocks submission while the acceptance box is unticked and shows the translated error", async () => {
    await renderWithProviders(<RegisterPage />, { initialPath: "/register" });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(m.auth_field_username()), "alice");
    await user.type(screen.getByLabelText(m.auth_field_display_name()), "Alice");
    await user.type(screen.getByLabelText(m.auth_field_email()), "alice@example.com");
    await user.type(screen.getByLabelText(m.auth_field_password()), "password1");
    await user.type(screen.getByLabelText(m.auth_field_confirm_password()), "password1");
    await user.type(screen.getByLabelText(m.auth_field_date_of_birth()), "1995-01-01");

    // The page has exactly one checkbox, so no name filter is needed to find
    // it — and `getByRole` fails loudly if a second one ever appears.
    const termsBox = screen.getByRole("checkbox");
    expect(termsBox).not.toBeChecked();
    for (const part of termsNameParts) {
      expect(termsBox).toHaveAccessibleName(expect.stringContaining(part));
    }
    expect(screen.getByRole("link", { name: m.legal_terms_of_service() })).toHaveAttribute(
      "href",
      "/terms",
    );
    expect(screen.getByRole("link", { name: m.legal_privacy_policy() })).toHaveAttribute(
      "href",
      "/privacy",
    );

    await user.click(screen.getByRole("button", { name: m.auth_register() }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(m.validation_terms_required()),
    );
    expect(authClient.signUp.email).not.toHaveBeenCalled();
  });

  it("submits once the acceptance box is ticked", async () => {
    await renderWithProviders(<RegisterPage />, { initialPath: "/register" });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(m.auth_field_username()), "alice");
    await user.type(screen.getByLabelText(m.auth_field_display_name()), "Alice");
    await user.type(screen.getByLabelText(m.auth_field_email()), "alice@example.com");
    await user.type(screen.getByLabelText(m.auth_field_password()), "password1");
    await user.type(screen.getByLabelText(m.auth_field_confirm_password()), "password1");
    await user.type(screen.getByLabelText(m.auth_field_date_of_birth()), "1995-01-01");
    await user.click(screen.getByRole("checkbox"));

    await user.click(screen.getByRole("button", { name: m.auth_register() }));

    await waitFor(() => expect(authClient.signUp.email).toHaveBeenCalled());
  });
});
