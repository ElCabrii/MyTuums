import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RegisterPage } from "@/routes/register";
import { authClient } from "@/lib/auth-client";
import { m } from "@/paraglide/messages.js";

beforeEach(() => {
  vi.clearAllMocks();
});

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

    expect(screen.getByRole("checkbox", { name: /I have read and agree/i })).not.toBeChecked();
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
    await user.click(screen.getByRole("checkbox", { name: /I have read and agree/i }));

    await user.click(screen.getByRole("button", { name: m.auth_register() }));

    await waitFor(() => expect(authClient.signUp.email).toHaveBeenCalled());
  });
});
