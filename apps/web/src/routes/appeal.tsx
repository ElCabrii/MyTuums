import { createFileRoute } from "@tanstack/react-router";
import { AppealPage } from "@/components/moderation/appeal-page";
import { pageHead } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";
import { z } from "zod";

export const Route = createFileRoute("/appeal")({
  head: () => pageHead(m.appeal_title()),
  component: AppealPage,
  /**
   * `token` and `postId` arrive from *outside* — the moderation email and the
   * removed-post stub link — so both are narrowed to strings rather than
   * trusted: anything else is dropped and the page renders its "missing
   * identifier" card instead of a raw value.
   */
  validateSearch: (search) => appealSearchSchema.parse(search),
});

const appealSearchSchema = z.object({
  token: z.string().optional(),
  postId: z.string().optional(),
});

/** The two identifiers the appeal page accepts from its URL, both optional. */
