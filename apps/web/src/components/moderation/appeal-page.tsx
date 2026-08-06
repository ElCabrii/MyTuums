import { useAtom, useAtomValue } from "jotai";
import { Link, getRouteApi } from "@tanstack/react-router";
import { ORPCError } from "@orpc/client";
import { APPEAL_REASON_MAX_LENGTH, APPEAL_REASON_MIN_LENGTH } from "@my-tuums/api/constants";
import { appealOpenAtom, appealReasonAtom } from "@/atoms/moderation";
import { isSignedInAtom } from "@/atoms/session";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/paraglide/messages.js";

const routeApi = getRouteApi("/appeal");

/**
 * The appeal page — the app's one signed-out surface. Two entry points: a
 * capability token from the moderation email (`?token=`) or, signed in, a
 * removed post's stub (`?postId=`). The form keeps its draft in a module atom
 * so an error retry doesn't lose the text; success resets it via the
 * mutation's onSuccess.
 */
export function AppealPage() {
  const { token, postId } = routeApi.useSearch();
  const isSignedIn = useAtomValue(isSignedInAtom);
  const appealOpen = useAtomValue(appealOpenAtom);
  const [reason, setReason] = useAtom(appealReasonAtom);

  const trimmed = reason.trim();
  const hasIdentifier = Boolean(token || postId);
  const vars = token
    ? { token, reason: trimmed }
    : postId
      ? { postId, reason: trimmed }
      : null;

  return (
    <div className="container mx-auto max-w-md px-4 py-16">
      <div className="rounded-3xl border border-border/50 bg-card/60 p-6 text-center shadow-2xl backdrop-blur-xl space-y-4 sm:p-8">
        {!hasIdentifier ? (
          <>
            <h1 className="text-xl font-bold tracking-tight">{m.appeal_missing_title()}</h1>
            <p className="text-sm text-muted-foreground">{m.appeal_missing_body()}</p>
            <Button nativeButton={false} render={<Link to="/" className="gap-1.5" />}>
              {m.common_back_to_home()}
            </Button>
          </>
        ) : appealOpen.isSuccess ? (
          <>
            <h1 className="text-xl font-bold tracking-tight">{m.appeal_success_title()}</h1>
            <p className="text-sm text-muted-foreground">{m.appeal_success_body()}</p>
          </>
        ) : appealOpen.isError ? (
          <>
            <h1 className="text-xl font-bold tracking-tight">
              {appealOpen.error instanceof ORPCError && appealOpen.error.code === "BAD_REQUEST"
                ? m.appeal_invalid_title()
                : m.appeal_error_title()}
            </h1>
            {appealOpen.error instanceof ORPCError &&
            appealOpen.error.code === "UNAUTHORIZED" &&
            !isSignedIn ? (
              <p className="text-sm text-muted-foreground">
                {m.appeal_sign_in()}{" "}
                <Link to="/login" className="text-primary hover:underline">
                  {m.auth_log_in()}
                </Link>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {appealOpen.error?.message ?? m.appeal_error_body()}
              </p>
            )}
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold tracking-tight">{m.appeal_title()}</h1>
            <p className="text-sm text-muted-foreground">{m.appeal_subtitle()}</p>
            <div className="space-y-2 text-left">
              <label htmlFor="appeal-reason" className="text-sm font-medium">
                {m.appeal_field_reason()}
              </label>
              <Textarea
                id="appeal-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={APPEAL_REASON_MAX_LENGTH}
                minLength={APPEAL_REASON_MIN_LENGTH}
                className="min-h-32"
              />
              <p className="text-xs text-muted-foreground">{m.appeal_reason_hint()}</p>
            </div>
            <Button
              className="w-full"
              disabled={!vars || trimmed.length < APPEAL_REASON_MIN_LENGTH || appealOpen.isPending}
              onClick={() => vars && appealOpen.mutate(vars)}
            >
              {appealOpen.isPending ? m.appeal_submitting() : m.appeal_submit()}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
