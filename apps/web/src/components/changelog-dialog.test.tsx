import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { sessionAtom } from "@/atoms/session";
import { ChangelogDialog } from "@/components/changelog-dialog";
import { sessionStore } from "@/lib/auth-client";
import { setTestSession, signedInSession } from "@/test/auth-fixture";
import { renderWithProviders } from "@/test/render";
import { m } from "@/paraglide/messages.js";

const CHANGELOG_HTML = "<h2>Highlights</h2><ul><li>Better feeds</li></ul>";

describe("ChangelogDialog", () => {
  it("shows the current release to a new signed-out device and stays quiet after dismissal", async () => {
    const user = userEvent.setup();
    const rendered = await renderWithProviders(<ChangelogDialog content={CHANGELOG_HTML} />, {
      initialPath: "/login",
    });

    expect(await screen.findByRole("heading", { name: "Highlights" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: m.changelog_dialog_dismiss() }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(localStorage.getItem("my-tuums.seen-changelog-version")).not.toBeNull();

    await act(async () => {
      await rendered.router.navigate({ to: "/privacy" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("yields to mandatory legal consent", async () => {
    const staleViewer = {
      legalAcceptedAt: new Date("2020-01-01T00:00:00.000Z"),
      legalVersion: "2020-01-01",
    };
    const store = createStore();
    setTestSession(signedInSession(staleViewer));
    store.set(sessionAtom, sessionStore.get());

    await renderWithProviders(<ChangelogDialog content={CHANGELOG_HTML} />, {
      signedInAs: staleViewer,
      store,
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("silently records a release that has no changelog", async () => {
    await renderWithProviders(<ChangelogDialog content={null} />, { initialPath: "/login" });

    await waitFor(() =>
      expect(localStorage.getItem("my-tuums.seen-changelog-version")).not.toBeNull(),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
