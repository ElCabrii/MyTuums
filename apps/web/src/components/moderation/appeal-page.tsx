import { useAtom, useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { ORPCError } from "@orpc/client";
import { APPEAL_REASON_MAX_LENGTH, APPEAL_REASON_MIN_LENGTH } from "@my-tuums/api/constants";
import {
  appealOpenAtom,
  appealPreviewFamily,
  appealReasonAtom,
  encodeAppealKey,
  resetAppealReasonEffect,
} from "@/atoms/moderation";
import { isSignedInAtom } from "@/atoms/session";
import { Button } from "@/components/ui/button";
import { PostAttachmentGrid } from "@/components/post-attachment-grid";
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

/**
 * The post being appealed, when the server will show it.
 *
 * Renders nothing at all in every "no" case — signed out, still loading, a
 * refusal, or a suspension or ban with no post behind it. That is deliberate:
 * the preview is context for the form, never a precondition for it, and the
 * page must keep working for a banned appellant who cannot sign in to see it.
 *
 * The images come back through the ordinary `/media/` route, which the author
 * of a removed post is allowed to read (see `canViewPostMedia`); no capability
 * travels in the markup.
 */
function AppealPreview({ token, postId }: { token?: string; postId?: string }) {
  const preview = useAtomValue(appealPreviewFamily(encodeAppealKey({ token, postId })));
  if (!preview.isSuccess) return null;

  const { post } = preview.data;
  if (!post) return null;

  return (
    <div className="border-border/60 bg-muted/30 space-y-2 rounded-lg border p-3 text-left">
      <p className="text-muted-foreground text-xs font-medium">{m.appeal_preview_title()}</p>
      {post.content ? (
        <p className="text-foreground/90 text-sm leading-relaxed break-words whitespace-pre-line">
          {post.content}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm italic">{m.appeal_preview_no_text()}</p>
      )}
      <PostAttachmentGrid attachments={post.attachments} />
      {post.removedReason && (
        <p className="text-muted-foreground text-xs">
          {m.appeal_preview_reason({ reason: post.removedReason })}
        </p>
      )}
    </div>
  );
}

/** The data-backed half of the appeal page — keyed per identifier by its parent. */
function AppealCard({ token, postId }: { token?: string; postId?: string }) {
  const isSignedIn = useAtomValue(isSignedInAtom);
  const appealOpen = useAtomValue(appealOpenAtom);
  const [reason, setReason] = useAtom(appealReasonAtom);
  // Clears the draft once a submission succeeds — see `resetAppealReasonEffect`.
  useAtomValue(resetAppealReasonEffect);

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
        <AppealPreview token={token} postId={postId} />
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
