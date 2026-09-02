import { createFileRoute } from "@tanstack/react-router";
import { VerifyEmailPage } from "@/components/verify-email-page";
import { m } from "@/paraglide/messages.js";
import { z } from "zod";
import { pageHead } from "@/lib/document-head";

export const Route = createFileRoute("/verify-email")({
  head: () =>
    pageHead(m.auth_verify_title(), m.verify_email_document_description(), "/verify-email"),
  component: VerifyEmailPage,
  /**
   * `error` arrives from *outside*: Better Auth's `/verify-email` endpoint
   * appends `?error=<code>` (`TOKEN_EXPIRED`, `INVALID_TOKEN`,
   * `USER_NOT_FOUND`, `INVALID_USER`) to the callbackURL when a verification
   * link is bad, and redirects the browser here. Narrowed to a string, never
   * trusted — and every code maps to the same generic message below, so the
   * page cannot become an account-existence oracle (issue #172).
   */
  validateSearch: (search) => verifyEmailSearchSchema.parse(search),
});

const verifyEmailSearchSchema = z.object({
  error: z.string().optional(),
  /**
   * The pre-login destination, carried from `/login` or `/register` so the
   * trip survives email verification: this page hands it to
   * `useRedirectWhenSignedIn`, and the resend puts it back in the
   * verification link's `callbackURL` so a link opened in a *different*
   * browser still lands the person where they were headed. Sanitized at every
   * use by `lib/redirect.ts` — it arrives in the URL and is never trusted.
   */
  redirect: z.string().optional(),
});
