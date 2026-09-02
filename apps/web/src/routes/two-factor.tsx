import { createFileRoute } from "@tanstack/react-router";
import { TwoFactorPage } from "@/components/two-factor-page";
import { z } from "zod";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";

export const Route = createFileRoute("/two-factor")({
  head: () =>
    pageHead(m.twofa_challenge_title(), m.two_factor_document_description(), "/two-factor"),
  component: TwoFactorPage,
  /**
   * The `redirect` param lands here from `/login` when the person was in the
   * middle of a sign-in that needed a second factor — see login.tsx. After the
   * challenge succeeds and a real session appears, `useRedirectWhenSignedIn`
   * reads it back and finishes the trip to the page the gate had sent them
   * from. Direct hits have no param and behave as before.
   */
  validateSearch: (search) => redirectSearchSchema.parse(search),
});

const redirectSearchSchema = z.object({ redirect: z.string().optional() });
