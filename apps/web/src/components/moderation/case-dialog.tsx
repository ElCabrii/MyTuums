import { useAtom, useAtomValue } from "jotai";
import { AlertCircle, Loader2 } from "lucide-react";
import { MODERATION_NOTE_MAX_LENGTH } from "@my-tuums/api/constants";
import {
  appealReviewAtom,
  banUserAtom,
  caseAtom,
  caseBanReasonAtom,
  caseDismissNoteAtom,
  caseRemoveReasonAtom,
  caseReviewNoteAtom,
  caseSuspendDurationAtom,
  caseSuspendReasonAtom,
  removePostAtom,
  resetCaseFormEffect,
  resolveAtom,
  restorePostAtom,
  suspendUserAtom,
  unbanUserAtom,
  type CaseRef,
} from "@/atoms/moderation";
import { isStaffAtom } from "@/atoms/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { reasonLabel, roleLabel } from "@/components/moderation/labels";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { ModerationCaseDetail } from "@/lib/orpc";
import { handleOf } from "@/lib/user";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

/** The suspension lengths the case dialog offers, seconds → label. */
const SUSPENSION_PRESETS: { seconds: number; label: string }[] = [
  { seconds: 60 * 60, label: m.moderation_duration_1h() },
  { seconds: 24 * 60 * 60, label: m.moderation_duration_24h() },
  { seconds: 7 * 24 * 60 * 60, label: m.moderation_duration_7d() },
  { seconds: 30 * 24 * 60 * 60, label: m.moderation_duration_30d() },
  { seconds: 365 * 24 * 60 * 60, label: m.moderation_duration_1y() },
];

/**
 * One moderation case: the full report history, the open appeal when there is
 * one, and every action the viewer's rank allows. Mounted by the queue view
 * while a case is open (`caseDialogAtom`); the dialog's form fields reset per
 * open via `resetCaseFormEffect`, so a reopened case never shows stale drafts.
 */
export function CaseDialog({ target, onClose }: { target: CaseRef; onClose: () => void }) {
  useAtomValue(resetCaseFormEffect);
  const caseQuery = useAtomValue(caseAtom(target));

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.moderation_case_title()}</DialogTitle>
          <DialogDescription>
            {target.targetType === "post" ? m.moderation_case_target_post() : m.moderation_case_target_user()}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 pb-6">
          {caseQuery.isPending ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none text-primary" />
            </div>
          ) : caseQuery.isError ? (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="space-y-2">
                <p>{caseQuery.error.message || m.moderation_case_error()}</p>
                <Button variant="outline" size="sm" onClick={() => void caseQuery.refetch()}>
                  {m.common_try_again()}
                </Button>
              </div>
            </div>
          ) : (
            <CaseBody detail={caseQuery.data} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The data-backed half of the case dialog — mounted only once the case query
 * resolved, so its hooks are unconditional while the dialog stays closed.
 * Reads the case dialog's form atoms; the case identity lives in the parent.
 */
function CaseBody({ detail }: { detail: ModerationCaseDetail }) {
  const isStaff = useAtomValue(isStaffAtom);
  const removePost = useAtomValue(removePostAtom);
  const restorePost = useAtomValue(restorePostAtom);
  const resolve = useAtomValue(resolveAtom);
  const suspendUser = useAtomValue(suspendUserAtom);
  const banUser = useAtomValue(banUserAtom);
  const unbanUser = useAtomValue(unbanUserAtom);
  const appealReview = useAtomValue(appealReviewAtom);
  const [removeReason, setRemoveReason] = useAtom(caseRemoveReasonAtom);
  const [dismissNote, setDismissNote] = useAtom(caseDismissNoteAtom);
  const [suspendReason, setSuspendReason] = useAtom(caseSuspendReasonAtom);
  const [suspendDuration, setSuspendDuration] = useAtom(caseSuspendDurationAtom);
  const [banReason, setBanReason] = useAtom(caseBanReasonAtom);
  const [reviewNote, setReviewNote] = useAtom(caseReviewNoteAtom);

  const targetPost = detail.target.kind === "post" ? detail.target : null;
  const targetUser = detail.target.kind === "user" ? detail.target : null;
  const appeal = detail.appeal;

  return (
    <div className="space-y-5">
      {/* The target, with the moderator projection: raw content even when removed. */}
      {targetPost && <TargetPostCard target={targetPost} />}
      {targetUser && <TargetUserCard target={targetUser} />}

      <ReportsSection reports={detail.reports} />

      {appeal && (
        <section className="space-y-2 rounded-xl border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{m.moderation_case_appeal_title()}</h3>
            {appeal.status !== "open" && (
              <Badge variant="secondary">
                {appeal.status === "overturned"
                  ? m.moderation_appeal_status_overturned()
                  : m.moderation_appeal_status_upheld()}
              </Badge>
            )}
          </div>
          <p className="break-words whitespace-pre-line text-sm">{appeal.reason}</p>
          <p className="text-xs text-muted-foreground">
            {formatRelativeTime(appeal.createdAt, getLocale(), m.post_just_now())}
          </p>
          {appeal.status === "open" && (
            <div className="space-y-2 pt-1">
              <label htmlFor="case-review-note" className="text-xs font-medium text-muted-foreground">
                {m.moderation_case_appeal_note_label()}
              </label>
              <Textarea
                id="case-review-note"
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
                maxLength={MODERATION_NOTE_MAX_LENGTH}
                className="min-h-16"
              />
              {appealReview.isError && (
                <p role="alert" className="text-xs text-destructive">
                  {appealReview.error?.message ?? m.moderation_case_appeal_error()}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={appealReview.isPending}
                  onClick={() =>
                    appealReview.mutate({
                      appealId: appeal.id,
                      outcome: "upheld",
                      note: reviewNote.trim() || undefined,
                    })
                  }
                >
                  {m.moderation_case_appeal_uphold()}
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  disabled={appealReview.isPending}
                  onClick={() =>
                    appealReview.mutate({
                      appealId: appeal.id,
                      outcome: "overturned",
                      note: reviewNote.trim() || undefined,
                    })
                  }
                >
                  {m.moderation_case_appeal_overturn()}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{m.moderation_actions_title()}</h3>
        {targetPost &&
          (targetPost.removedAt ? (
            <Button
              variant="outline"
              className="w-full"
              disabled={restorePost.isPending}
              onClick={() => restorePost.mutate({ postId: targetPost.id })}
            >
              {m.moderation_restore_post()}
            </Button>
          ) : (
            <div className="space-y-2">
              <label htmlFor="case-remove-reason" className="text-xs font-medium text-muted-foreground">
                {m.moderation_remove_reason_label()}
              </label>
              <Textarea
                id="case-remove-reason"
                value={removeReason}
                onChange={(event) => setRemoveReason(event.target.value)}
                maxLength={MODERATION_NOTE_MAX_LENGTH}
                className="min-h-16"
              />
              {removePost.isError && (
                <p role="alert" className="text-xs text-destructive">
                  {removePost.error?.message ?? m.moderation_remove_error()}
                </p>
              )}
              <Button
                variant="destructive"
                className="w-full"
                disabled={!removeReason.trim() || removePost.isPending}
                onClick={() =>
                  removePost.mutate({ postId: targetPost.id, reason: removeReason.trim() })
                }
              >
                {m.moderation_remove_submit()}
              </Button>
            </div>
          ))}

        {targetUser && (
          <div className="space-y-2">
            {targetUser.banned ? (
              <Button
                variant="outline"
                className="w-full"
                disabled={unbanUser.isPending}
                onClick={() => unbanUser.mutate({ userId: targetUser.id })}
              >
                {targetUser.banExpires ? m.moderation_unsuspend() : m.moderation_unban()}
              </Button>
            ) : (
              <>
                <label htmlFor="case-suspend-duration" className="text-xs font-medium text-muted-foreground">
                  {m.moderation_duration_label()}
                </label>
                <Select
                  value={String(suspendDuration)}
                  onValueChange={(value) => setSuspendDuration(Number(value))}
                >
                  <SelectTrigger id="case-suspend-duration" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUSPENSION_PRESETS.map((preset) => (
                      <SelectItem key={preset.seconds} value={String(preset.seconds)}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <label htmlFor="case-suspend-reason" className="text-xs font-medium text-muted-foreground">
                  {m.moderation_suspend_reason_label()}
                </label>
                <Textarea
                  id="case-suspend-reason"
                  value={suspendReason}
                  onChange={(event) => setSuspendReason(event.target.value)}
                  maxLength={MODERATION_NOTE_MAX_LENGTH}
                  className="min-h-16"
                />
                {suspendUser.isError && (
                  <p role="alert" className="text-xs text-destructive">
                    {suspendUser.error?.message ?? m.moderation_suspend_error()}
                  </p>
                )}
                <Button
                  variant="destructive"
                  className="w-full"
                  disabled={!suspendReason.trim() || suspendUser.isPending}
                  onClick={() =>
                    suspendUser.mutate({
                      userId: targetUser.id,
                      reason: suspendReason.trim(),
                      durationSeconds: suspendDuration,
                    })
                  }
                >
                  {m.moderation_suspend()}
                </Button>
                {isStaff && (
                  <div className="space-y-2 border-t border-border/50 pt-3">
                    <label htmlFor="case-ban-reason" className="text-xs font-medium text-muted-foreground">
                      {m.moderation_ban_reason_label()}
                    </label>
                    <Textarea
                      id="case-ban-reason"
                      value={banReason}
                      onChange={(event) => setBanReason(event.target.value)}
                      maxLength={MODERATION_NOTE_MAX_LENGTH}
                      className="min-h-16"
                    />
                    {banUser.isError && (
                      <p role="alert" className="text-xs text-destructive">
                        {banUser.error?.message ?? m.moderation_ban_error()}
                      </p>
                    )}
                    <Button
                      variant="destructive"
                      className="w-full"
                      disabled={!banReason.trim() || banUser.isPending}
                      onClick={() => banUser.mutate({ userId: targetUser.id, reason: banReason.trim() })}
                    >
                      {m.moderation_ban()}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="space-y-2">
          <label htmlFor="case-dismiss-note" className="text-xs font-medium text-muted-foreground">
            {m.moderation_dismiss_note_label()}
          </label>
          <Textarea
            id="case-dismiss-note"
            value={dismissNote}
            onChange={(event) => setDismissNote(event.target.value)}
            maxLength={MODERATION_NOTE_MAX_LENGTH}
            className="min-h-16"
          />
          {resolve.isError && (
            <p role="alert" className="text-xs text-destructive">
              {resolve.error?.message ?? m.moderation_dismiss_error()}
            </p>
          )}
          <Button
            variant="outline"
            className="w-full"
            disabled={resolve.isPending}
            onClick={() =>
              resolve.mutate({
                targetType: detail.target.kind,
                targetId: detail.target.id,
                outcome: "dismissed",
                note: dismissNote.trim() || undefined,
              })
            }
          >
            {m.moderation_dismiss()}
          </Button>
        </div>
      </section>
    </div>
  );
}

/** The post being moderated: author, raw content, moderation timestamps. */
function TargetPostCard({ target }: { target: Extract<ModerationCaseDetail["target"], { kind: "post" }> }) {
  const authorHandle = handleOf(target.author);
  return (
    <div className="space-y-1.5 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-sm font-bold">{target.author.name || m.user_unknown()}</span>
        {authorHandle && <span className="text-xs text-muted-foreground">@{authorHandle}</span>}
        {target.removedAt && <Badge variant="secondary">{m.moderation_case_removed_badge()}</Badge>}
      </div>
      <p className="break-words whitespace-pre-line text-sm">{target.content}</p>
      <p className="text-xs text-muted-foreground">
        {formatRelativeTime(target.createdAt, getLocale(), m.post_just_now())}
      </p>
    </div>
  );
}

/** The user being moderated: role, ban state, and the suspension deadline when there is one. */
function TargetUserCard({ target }: { target: Extract<ModerationCaseDetail["target"], { kind: "user" }> }) {
  const userHandle = handleOf(target);
  return (
    <div className="space-y-1.5 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-sm font-bold">{target.name || m.user_unknown()}</span>
        {userHandle && <span className="text-xs text-muted-foreground">@{userHandle}</span>}
        <Badge variant="outline">{roleLabel(target.role ?? "user")}</Badge>
        {target.banned &&
          (target.banExpires ? (
            <Badge variant="destructive">
              {m.moderation_case_suspended_until({ date: formatDateTime(target.banExpires, getLocale()) })}
            </Badge>
          ) : (
            <Badge variant="destructive">{m.moderation_case_banned_badge()}</Badge>
          ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {formatRelativeTime(target.createdAt, getLocale(), m.post_just_now())}
      </p>
    </div>
  );
}

/** Every report against the target, newest first, with resolved state. */
function ReportsSection({ reports }: { reports: ModerationCaseDetail["reports"] }) {
  if (reports.length === 0) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{m.moderation_case_reports_title()}</h3>
        <p className="text-xs text-muted-foreground">{m.moderation_case_reports_empty()}</p>
      </section>
    );
  }
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{m.moderation_case_reports_title()}</h3>
      <ul className="space-y-2">
        {reports.map((report) => (
          <li key={report.reporterId} className="flex items-start gap-2 text-sm">
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
              {reasonLabel(report.reason)}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(report.createdAt, getLocale(), m.post_just_now())}
            </span>
            {report.resolvedAt && (
              <span className="ml-auto text-xs text-muted-foreground">
                {report.resolvedOutcome === "actioned"
                  ? m.moderation_report_resolved_actioned()
                  : m.moderation_report_resolved_dismissed()}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
