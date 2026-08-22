import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RegisterPage } from "@/routes/register";
import { authClient, type AuthClientAction } from "@/lib/auth-client";
import { m } from "@/paraglide/messages.js";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";

type SignUpEmailBody = {
  legalAcceptedAt?: string;
  legalVersion?: string;
};

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
const legalNameParts = [
  m.auth_register_terms_before().trim(),
  m.legal_terms_of_service(),
  m.legal_privacy_policy(),
];

describe("RegisterPage — Legal acceptance (issue #153)", () => {
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
    const legalBox = screen.getByRole("checkbox");
    expect(legalBox).not.toBeChecked();
    for (const part of legalNameParts) {
      expect(legalBox).toHaveAccessibleName(expect.stringContaining(part));
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

    // SAFETY: the recording fake is called with the sign-up body at runtime;
    // the test narrows only the two fields this issue adds.
    const signUpEmailMock = vi.mocked(authClient.signUp.email as AuthClientAction);
    // SAFETY: the recording fake is called with the sign-up body at runtime;
    // the test narrows only the two fields this issue adds.
    const body = signUpEmailMock.mock.calls[0]?.[0] as SignUpEmailBody;
    expect(body.legalVersion).toBe(LEGAL_VERSION);
    expect(body.legalAcceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});


/**
 * The `?redirect=` handoff through email verification (issue #172 review).
 * A visitor bounced to `/login` from a protected page, who then registers,
 * must still reach that page once verified.
 */
describe("RegisterPage — the pre-login destination", () => {
  it("carries ?redirect= into the verification link and the pending screen", async () => {
    const { router } = await renderWithProviders(<RegisterPage />, {
      initialPath: "/register?redirect=%2Fsettings%2Faccount",
    });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(m.auth_field_username()), "alexmercer");
    await user.type(screen.getByLabelText(m.auth_field_display_name()), "Alex Mercer");
    await user.type(screen.getByLabelText(m.auth_field_email()), "alex@example.com");
    await user.type(screen.getByLabelText(m.auth_field_password()), "password1");
    await user.type(screen.getByLabelText(m.auth_field_confirm_password()), "password1");
    await user.type(screen.getByLabelText(m.auth_field_date_of_birth()), "1995-01-01");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: m.auth_register() }));

    // Inside the emailed link, so a link opened in another browser still lands
    // there — no atom or history entry survives that hop.
    await waitFor(() =>
      expect(authClient.signUp.email).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${window.location.origin}/verify-email?redirect=%2Fsettings%2Faccount`,
        }),
      ),
    );
    // And on the navigation, so the pending screen's own resend keeps it too.
    await waitFor(() => expect(router.state.location.pathname).toBe("/verify-email"));
    expect(router.state.location.search).toEqual({ redirect: "/settings/account" });
  });
});
