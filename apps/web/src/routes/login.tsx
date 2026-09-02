import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "@/components/login-page";
import { m } from "@/paraglide/messages.js";
import { z } from "zod";
import { pageHead } from "@/lib/document-head";

export const Route = createFileRoute("/login")({
  head: () => pageHead(m.auth_log_in(), m.login_document_description(), "/login"),
  component: LoginPage,
  /**
   * Two search params, and together they prove the rule CONTEXT.md states:
   * view state belongs in an atom because a URL nobody can link to is the
   * cost. Neither of these is view state — each arrives from *outside*.
   *
   * `error` is handed back by an external redirect (BetterAuth's OAuth
   * callback appends `?error=<code>` to `errorCallbackURL`); `redirect` is
   * written by the site's own signed-in gate (`use-require-signed-in.ts`)
   * but read back from `window.location`, and it round-trips through the
   * provider during OAuth. A query param is the only channel either has, so
   * the exception stands.
   *
   * Both are narrowed to a string rather than trusted: they arrive from
   * outside, so anything else is dropped instead of being rendered — and
   * `redirect` is sanitized again in `lib/redirect.ts` before any navigation
   * honours it.
   *
   * `error_description` (issue #74) is deliberately NOT captured here even
   * though BetterAuth's OAuth callback appends one alongside `error`: it's
   * the server's raw, unlocalized English exception message, and every code
   * this page knows how to react to already has its own Paraglide copy
   * (`localizeOAuthError`, or the dedicated `/banned` screen for
   * `BANNED_USER`) that says the same thing in the viewer's language. Reading
   * it would only reintroduce the thing this issue removes — a
   * server-controlled English string surfacing in the UI — for codes that
   * fall through to the generic `auth_oauth_failed` message anyway.
   */
  validateSearch: (search) => loginSearchSchema.parse(search),
});

const loginSearchSchema = z.object({
  error: z.string().optional(),
  redirect: z.string().optional(),
});
