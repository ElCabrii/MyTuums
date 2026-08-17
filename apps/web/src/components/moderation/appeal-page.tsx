import { useAtom, useAtomValue } from "jotai";
import { useEffect, type ReactNode } from "react";
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
 * removed post's stub (`?postId=`).
 *
 * The card is keyed on the identifier: navigating `/appeal?postId=a` →
 * `?postId=b` (or a token swap) remounts it, dropping the mutation atom's
 * last subscriber so its observer resets — a submitted state from one link
 * must not greet the next link's form.
 */
export function AppealPage() {
  const { token, postId } = routeApi.useSearch();
  const identifier = token ?? postId ?? "none";
  return <AppealCard key={identifier} token={token} postId={postId} />;
}

/** The data-backed half of the appeal page — keyed per identifier by its parent. */
function AppealCard({ token, postId }: { token?: string; postId?: string }) {
  const isSignedIn = useAtomValue(isSignedInAtom);
  const appealOpen = useAtomValue(appealOpenAtom);
  const [reason, setReason] = useAtom(appealReasonAtom);

  // A successful submission starts the next appeal blank. The reset lives
  // here rather than in `appealOpenAtom.onSuccess`, because that callback is
  // handed only a Getter and cannot `set` — and writing through a module-scope
  // store would miss whatever Jotai Provider actually mounted this page (e.g.
  // the harness's fresh store in a test). `setReason` is already bound to the
  // active Provider store, so the reset lands where the mutation ran.
  // `isSuccess` is reset by the card's own remount on identifier change, so
  // the effect does not re-fire into a fresh form.
  useEffect(() => {
    if (appealOpen.isSuccess) {
      setReason("");
    }
  }, [appealOpen.isSuccess, setReason]);

  const trimmed = reason.trim();
  const hasIdentifier = Boolean(token || postId);
  let vars: { token: string; reason: string } | { postId: string; reason: string } | null = null;
  if (token) {
    vars = { token, reason: trimmed };
  } else if (postId) {
    vars = { postId, reason: trimmed };
  }

  // The four card states, as positive-form branches — the same chain the
  // route rendered as nested ternaries, minus the readability tax.
  let cardContent: ReactNode;
  if (hasIdentifier && appealOpen.isSuccess) {
    cardContent = (
      <>
        <h1 className="text-xl font-bold tracking-tight">{m.appeal_success_title()}</h1>
        <p className="text-muted-foreground text-sm">{m.appeal_success_body()}</p>
      </>
    );
  } else if (hasIdentifier && appealOpen.isError) {
    cardContent = (
      <>
        <h1 className="text-xl font-bold tracking-tight">
          {appealOpen.error instanceof ORPCError && appealOpen.error.code === "BAD_REQUEST"
            ? m.appeal_invalid_title()
            : m.appeal_error_title()}
        </h1>
        {appealOpen.error instanceof ORPCError &&
        appealOpen.error.code === "UNAUTHORIZED" &&
        isSignedIn ? (
          <p className="text-muted-foreground text-sm">
            {appealOpen.error?.message ?? m.appeal_error_body()}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            {appealOpen.error instanceof ORPCError &&
            appealOpen.error.code === "UNAUTHORIZED" &&
            !isSignedIn ? (
              <>
                {m.appeal_sign_in()}{" "}
                <Link to="/login" className="text-primary hover:underline">
                  {m.auth_log_in()}
                </Link>
              </>
            ) : (
              (appealOpen.error?.message ?? m.appeal_error_body())
            )}
          </p>
        )}
      </>
    );
  } else if (hasIdentifier) {
    cardContent = (
      <>
        <h1 className="text-xl font-bold tracking-tight">{m.appeal_title()}</h1>
        <p className="text-muted-foreground text-sm">{m.appeal_subtitle()}</p>
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
          <p className="text-muted-foreground text-xs">{m.appeal_reason_hint()}</p>
        </div>
        <Button
          className="w-full"
          disabled={!vars || trimmed.length < APPEAL_REASON_MIN_LENGTH || appealOpen.isPending}
          onClick={() => vars && appealOpen.mutate(vars)}
        >
          {appealOpen.isPending ? m.appeal_submitting() : m.appeal_submit()}
        </Button>
      </>
    );
  } else {
    cardContent = (
      <>
        <h1 className="text-xl font-bold tracking-tight">{m.appeal_missing_title()}</h1>
        <p className="text-muted-foreground text-sm">{m.appeal_missing_body()}</p>
        <Button nativeButton={false} render={<Link to="/" className="gap-1.5" />}>
          {m.common_back_to_home()}
        </Button>
      </>
    );
  }

  return (
    <div className="container mx-auto max-w-md px-4 py-16">
      <div className="border-border/50 bg-card/60 space-y-4 rounded-3xl border p-6 text-center shadow-2xl backdrop-blur-xl sm:p-8">
        {cardContent}
      </div>
    </div>
  );
}
