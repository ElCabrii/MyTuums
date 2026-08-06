import { createFileRoute } from "@tanstack/react-router";
import { AppealPage } from "@/components/moderation/appeal-page";

export const Route = createFileRoute("/appeal")({
  component: AppealPage,
  /**
   * `token` and `postId` arrive from *outside* — the moderation email and the
   * removed-post stub link — so both are narrowed to strings rather than
   * trusted: anything else is dropped and the page renders its "missing
   * identifier" card instead of a raw value.
   */
  validateSearch: (search: Record<string, unknown>): { token?: string; postId?: string } => ({
    ...(typeof search.token === "string" ? { token: search.token } : {}),
    ...(typeof search.postId === "string" ? { postId: search.postId } : {}),
  }),
});
