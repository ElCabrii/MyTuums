import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { RegisterPage } from "@/components/register-page";
import { m } from "@/paraglide/messages.js";
import { pageHead } from "@/lib/document-head";

export const Route = createFileRoute("/register")({
  head: () => pageHead(m.auth_register(), m.register_document_description(), "/register"),
  component: RegisterPage,
  /**
   * The `redirect` param is the one the signed-in gate set on `/login`
   * (`use-require-signed-in.ts`) and that the "Register here" link carried
   * here — see login.tsx for the rationale. Narrowed to a string: it arrives
   * in the URL, and it is sanitized again in `lib/redirect.ts` before any
   * navigation honours it.
   */
  validateSearch: (search) => redirectSearchSchema.parse(search),
});

const redirectSearchSchema = z.object({ redirect: z.string().optional() });
