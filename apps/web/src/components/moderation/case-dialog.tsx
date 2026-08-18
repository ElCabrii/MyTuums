import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import {
  AlertCircle,
  Ban,
  CheckCheck,
  CircleCheck,
  ExternalLink,
  Flag,
  Gavel,
  Hourglass,
  MessageSquareReply,
  Trash2,
  Undo2,
} from "lucide-react";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { reasonBadgeVariant, reasonLabel, roleLabel } from "@/components/moderation/labels";
import { UserAvatar } from "@/components/user-avatar";
import { formatDateTime, formatJoinDate, formatRelativeTime } from "@/lib/format";
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
 * The same presets as a value → label map, for `SelectValue`: Base UI renders
 * the raw value ("86400") unless the root is told what each one is called.
 */
const SUSPENSION_LABELS: Record<string, string> = Object.fromEntries(
  SUSPENSION_PRESETS.map((preset) => [String(preset.seconds), preset.label]),
);

/**
 * One moderation case: the full report history, the open appeal when there is
 * one, and every action the viewer's rank allows. Mounted by the queue view
 * while a case is open (`caseDialogAtom`); the dialog's form fields reset per
 * open via `resetCaseFormEffect`, so a reopened case never shows stale drafts.
 *
 * The header is sticky because the body scrolls past it on a long report
 * history, and "which case am I acting on" is the one thing a moderator must
 * never lose while scrolling towards a destructive button.
 */
export function CaseDialog({ target, onClose }: { target: CaseRef; onClose: () => void }) {
  useAtomValue(resetCaseFormEffect);
  const caseQuery = useAtomValue(caseAtom(target));

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <DialogHeader className="bg-popover border-border sticky top-0 z-10 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Gavel className="size-4" />
            {m.moderation_case_title()}
          </DialogTitle>
          <DialogDescription>
            {target.targetType === "post"
              ? m.moderation_case_target_post()
              : m.moderation_case_target_user()}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-5">
          {caseQuery.isPending ? (
            <CaseSkeleton />
          ) : caseQuery.isError ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>{caseQuery.error.message || m.moderation_case_error()}</AlertTitle>
              <AlertDescription>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void caseQuery.refetch()}
                >
                  {m.common_try_again()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <CaseBody detail={caseQuery.data} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The shape of a loaded case, held while the query resolves. */
function CaseSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}

/**
 * The data-backed half of the case dialog — mounted only once the case query
 * resolved, so its hooks are unconditional while the dialog stays closed.
 * Reads the case dialog's form atoms; the case identity lives in the parent.
 *
 * Reading order is the order a decision is made in: what was done, who
 * reported it and why, what the author says about it, and only then the
 * buttons that change something.
 */
function CaseBody({ detail }: { detail: ModerationCaseDetail }) {
  const targetPost = detail.target.kind === "post" ? detail.target : null;
  const targetUser = detail.target.kind === "user" ? detail.target : null;

  return (
    <div className="space-y-4">
      {/* The target, with the moderator projection: raw content even when removed. */}
      {targetPost && <TargetPostCard target={targetPost} />}
      {targetUser && <TargetUserCard target={targetUser} />}

      <ReportsSection reports={detail.reports} />

      {detail.appeal && <AppealSection appeal={detail.appeal} />}

      <ActionsSection detail={detail} />
    </div>
  );
}

/** The post being moderated: author, raw content, and the removal it already carries. */
function TargetPostCard({
  target,
}: {
  target: Extract<ModerationCaseDetail["target"], { kind: "post" }>;
}) {
  const authorHandle = handleOf(target.author);
  const locale = getLocale();

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <UserAvatar
            user={target.author}
            alt={target.author.name || authorHandle || m.user_unknown()}
            className="size-8"
            fallbackClassName="text-xs"
          />
          <span className="truncate">{target.author.name || m.user_unknown()}</span>
          {authorHandle && (
            <span className="text-muted-foreground truncate text-xs font-normal">
              @{authorHandle}
            </span>
          )}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          <span title={formatDateTime(target.createdAt, locale)}>
            {formatRelativeTime(target.createdAt, locale, m.post_just_now())}
          </span>
          {target.parentId && (
            <Badge variant="outline">
              <MessageSquareReply />
              {m.moderation_case_reply_badge()}
            </Badge>
          )}
        </CardDescription>
        <CardAction>
          {/* A new tab, not a navigation: reading the post in context must not
              cost the moderator the case they are half-way through. */}
          <Button
            variant="ghost"
            size="xs"
            nativeButton={false}
            render={
              <Link
                to="/post/$postId"
                params={{ postId: target.id }}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            <ExternalLink />
            {m.moderation_case_open_post()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm break-words whitespace-pre-line">{target.content}</p>
        {target.removedAt && (
          <Alert variant="destructive">
            <Trash2 />
            <AlertTitle>{m.moderation_case_removed_badge()}</AlertTitle>
            {target.removedReason && (
              <AlertDescription>
                {m.moderation_post_removed_reason({ reason: target.removedReason })}
              </AlertDescription>
            )}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

/** The user being moderated: identity, rank, and the sentence they are already under. */
function TargetUserCard({
  target,
}: {
  target: Extract<ModerationCaseDetail["target"], { kind: "user" }>;
}) {
  const userHandle = handleOf(target);
  const locale = getLocale();

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <UserAvatar
            user={target}
            alt={target.name || userHandle || m.user_unknown()}
            className="size-8"
            fallbackClassName="text-xs"
          />
          <span className="truncate">{target.name || m.user_unknown()}</span>
          {userHandle && (
            <span className="text-muted-foreground truncate text-xs font-normal">
              @{userHandle}
            </span>
          )}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{roleLabel(target.role ?? "user")}</Badge>
          {target.banned &&
            (target.banExpires ? (
              <Badge variant="destructive">
                <Hourglass />
                {m.moderation_case_suspended_until({
                  date: formatDateTime(target.banExpires, locale),
                })}
              </Badge>
            ) : (
              <Badge variant="destructive">
                <Ban />
                {m.moderation_case_banned_badge()}
              </Badge>
            ))}
          <span>
            {m.moderation_case_joined({ date: formatJoinDate(target.createdAt, locale) })}
          </span>
        </CardDescription>
        {userHandle && (
          <CardAction>
            <Button
              variant="ghost"
              size="xs"
              nativeButton={false}
              render={
                <Link
                  to="/@{$username}"
                  params={{ username: userHandle }}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              <ExternalLink />
              {m.moderation_case_view_profile()}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {target.bio && (
          <p className="text-muted-foreground text-sm break-words whitespace-pre-line">
            {target.bio}
          </p>
        )}
        {target.banned && target.banReason && (
          <Alert variant="destructive">
            <Ban />
            <AlertTitle>
              {m.moderation_case_sanction_reason({ reason: target.banReason })}
            </AlertTitle>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

/** Every report against the target, newest first, with resolved state. */
function ReportsSection({ reports }: { reports: ModerationCaseDetail["reports"] }) {
  const locale = getLocale();
  const open = reports.filter((report) => report.resolvedAt === null).length;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Flag className="size-4" />
          {m.moderation_case_reports_title()}
          {open > 0 && <Badge variant="secondary">{String(open)}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {reports.length === 0 ? (
          <p className="text-muted-foreground text-sm">{m.moderation_case_reports_empty()}</p>
        ) : (
          /* `role="listitem"` on each row: `ItemGroup` renders `role="list"`,
             and a list whose children carry no list role is an
             aria-required-children violation, not a cosmetic one. */
          <ItemGroup className="gap-1.5">
            {reports.map((report) => (
              <Item key={report.reporterId} role="listitem" variant="muted" size="xs">
                <ItemContent>
                  <ItemTitle>
                    <Badge variant={reasonBadgeVariant(report.reason)}>
                      {reasonLabel(report.reason)}
                    </Badge>
                    <span
                      className="text-muted-foreground text-xs font-normal"
                      title={formatDateTime(report.createdAt, locale)}
                    >
                      {formatRelativeTime(report.createdAt, locale, m.post_just_now())}
                    </span>
                  </ItemTitle>
                </ItemContent>
                {report.resolvedAt && (
                  <ItemActions>
                    <Badge variant="outline">
                      <CheckCheck />
                      {report.resolvedOutcome === "actioned"
                        ? m.moderation_report_resolved_actioned()
                        : m.moderation_report_resolved_dismissed()}
                    </Badge>
                  </ItemActions>
                )}
              </Item>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The appeal, and — while it is open — the two-way decision on it. Ringed in
 * the primary colour rather than sitting in the same neutral card as the rest:
 * an open appeal is someone waiting on a reply, and it is the one thing on
 * this dialog with a person on the other end of it.
 */
function AppealSection({ appeal }: { appeal: NonNullable<ModerationCaseDetail["appeal"]> }) {
  const appealReview = useAtomValue(appealReviewAtom);
  const [reviewNote, setReviewNote] = useAtom(caseReviewNoteAtom);
  const isOpen = appeal.status === "open";
  const locale = getLocale();

  return (
    <Card size="sm" className={isOpen ? "ring-primary/30" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gavel className="size-4" />
          {m.moderation_case_appeal_title()}
        </CardTitle>
        {!isOpen && (
          <CardAction>
            <Badge variant="secondary">
              {appeal.status === "overturned"
                ? m.moderation_appeal_status_overturned()
                : m.moderation_appeal_status_upheld()}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm break-words whitespace-pre-line">{appeal.reason}</p>
        <p
          className="text-muted-foreground text-xs"
          title={formatDateTime(appeal.createdAt, locale)}
        >
          {formatRelativeTime(appeal.createdAt, locale, m.post_just_now())}
        </p>
        {isOpen && (
          <>
            <Separator />
            <Field>
              <FieldLabel htmlFor="case-review-note">
                {m.moderation_case_appeal_note_label()}
              </FieldLabel>
              <Textarea
                id="case-review-note"
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
                placeholder={m.moderation_case_appeal_note_placeholder()}
                maxLength={MODERATION_NOTE_MAX_LENGTH}
                className="min-h-16"
              />
              <FieldDescription className="text-right tabular-nums">
                <CharacterCount value={reviewNote} />
              </FieldDescription>
              {appealReview.isError && (
                <FieldError>
                  {appealReview.error?.message ?? m.moderation_case_appeal_error()}
                </FieldError>
              )}
            </Field>
            {appealReview.isSuccess && (
              <Alert>
                <CircleCheck />
                <AlertTitle>{m.moderation_case_appeal_done()}</AlertTitle>
              </Alert>
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
                <CheckCheck />
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
                <Undo2 />
                {m.moderation_case_appeal_overturn()}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Everything that changes something, in one card: the target-specific action
 * first, then the always-available way out of the case (dismiss) behind a
 * separator so the two are never mistaken for each other.
 */
function ActionsSection({ detail }: { detail: ModerationCaseDetail }) {
  const targetPost = detail.target.kind === "post" ? detail.target : null;
  const targetUser = detail.target.kind === "user" ? detail.target : null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{m.moderation_actions_title()}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {targetPost && <PostActions target={targetPost} />}
        {targetUser && <UserActions target={targetUser} />}
        <Separator />
        <DismissAction detail={detail} />
      </CardContent>
    </Card>
  );
}

/** Remove the post, or — once it carries a tombstone — put it back. */
function PostActions({
  target,
}: {
  target: Extract<ModerationCaseDetail["target"], { kind: "post" }>;
}) {
  const removePost = useAtomValue(removePostAtom);
  const restorePost = useAtomValue(restorePostAtom);
  const [removeReason, setRemoveReason] = useAtom(caseRemoveReasonAtom);

  if (target.removedAt) {
    return (
      <Button
        variant="outline"
        className="w-full"
        disabled={restorePost.isPending}
        onClick={() => restorePost.mutate({ postId: target.id })}
      >
        <Undo2 />
        {m.moderation_restore_post()}
      </Button>
    );
  }

  return (
    <FieldGroup className="gap-4">
      <Field>
        <FieldLabel htmlFor="case-remove-reason">{m.moderation_remove_reason_label()}</FieldLabel>
        <Textarea
          id="case-remove-reason"
          value={removeReason}
          onChange={(event) => setRemoveReason(event.target.value)}
          placeholder={m.moderation_remove_reason_placeholder()}
          maxLength={MODERATION_NOTE_MAX_LENGTH}
          className="min-h-16"
        />
        <FieldDescription className="text-right tabular-nums">
          <CharacterCount value={removeReason} />
        </FieldDescription>
        {removePost.isError && (
          <FieldError>{removePost.error?.message ?? m.moderation_remove_error()}</FieldError>
        )}
      </Field>
      <Button
        variant="destructive"
        className="w-full"
        disabled={!removeReason.trim() || removePost.isPending}
        onClick={() => removePost.mutate({ postId: target.id, reason: removeReason.trim() })}
      >
        <Trash2 />
        {m.moderation_remove_submit()}
      </Button>
    </FieldGroup>
  );
}

/**
 * Suspend, ban (staff), or lift whatever the account is already under.
 *
 * The lift is staff-only, matching `unbanUser`'s `staffProcedure` gate
 * server-side (`packages/api/src/moderation.ts`) — the same reasoning as Ban
 * below: a moderator who saw the button would have it 403 on click.
 */
function UserActions({
  target,
}: {
  target: Extract<ModerationCaseDetail["target"], { kind: "user" }>;
}) {
  const isStaff = useAtomValue(isStaffAtom);
  const suspendUser = useAtomValue(suspendUserAtom);
  const banUser = useAtomValue(banUserAtom);
  const unbanUser = useAtomValue(unbanUserAtom);
  const [suspendReason, setSuspendReason] = useAtom(caseSuspendReasonAtom);
  const [suspendDuration, setSuspendDuration] = useAtom(caseSuspendDurationAtom);
  const [banReason, setBanReason] = useAtom(caseBanReasonAtom);

  if (target.banned) {
    if (!isStaff) return null;
    return (
      <Button
        variant="outline"
        className="w-full"
        disabled={unbanUser.isPending}
        onClick={() => unbanUser.mutate({ userId: target.id })}
      >
        <Undo2 />
        {target.banExpires ? m.moderation_unsuspend() : m.moderation_unban()}
      </Button>
    );
  }

  return (
    <div className="space-y-4">
      {/* Both groups label their box "Reason", because both of those reasons
          are quoted verbatim to the user — the legend is what says which
          sentence the moderator is writing. */}
      <FieldSet>
        <FieldLegend variant="label">{m.moderation_actions_suspend_title()}</FieldLegend>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="case-suspend-duration">{m.moderation_duration_label()}</FieldLabel>
            <Select
              items={SUSPENSION_LABELS}
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
          </Field>
          <Field>
            <FieldLabel htmlFor="case-suspend-reason">
              {m.moderation_suspend_reason_label()}
            </FieldLabel>
            <Textarea
              id="case-suspend-reason"
              value={suspendReason}
              onChange={(event) => setSuspendReason(event.target.value)}
              placeholder={m.moderation_suspend_reason_placeholder()}
              maxLength={MODERATION_NOTE_MAX_LENGTH}
              className="min-h-16"
            />
            <FieldDescription className="text-right tabular-nums">
              <CharacterCount value={suspendReason} />
            </FieldDescription>
            {suspendUser.isError && (
              <FieldError>{suspendUser.error?.message ?? m.moderation_suspend_error()}</FieldError>
            )}
          </Field>
          <Button
            variant="destructive"
            className="w-full"
            disabled={!suspendReason.trim() || suspendUser.isPending}
            onClick={() =>
              suspendUser.mutate({
                userId: target.id,
                reason: suspendReason.trim(),
                durationSeconds: suspendDuration,
              })
            }
          >
            <Hourglass />
            {m.moderation_suspend()}
          </Button>
        </FieldGroup>
      </FieldSet>

      {isStaff && (
        <>
          <Separator />
          <FieldSet>
            <FieldLegend variant="label">{m.moderation_actions_ban_title()}</FieldLegend>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="case-ban-reason">{m.moderation_ban_reason_label()}</FieldLabel>
                <Textarea
                  id="case-ban-reason"
                  value={banReason}
                  onChange={(event) => setBanReason(event.target.value)}
                  placeholder={m.moderation_ban_reason_placeholder()}
                  maxLength={MODERATION_NOTE_MAX_LENGTH}
                  className="min-h-16"
                />
                <FieldDescription className="text-right tabular-nums">
                  <CharacterCount value={banReason} />
                </FieldDescription>
                {banUser.isError && (
                  <FieldError>{banUser.error?.message ?? m.moderation_ban_error()}</FieldError>
                )}
              </Field>
              <Button
                variant="destructive"
                className="w-full"
                disabled={!banReason.trim() || banUser.isPending}
                onClick={() => banUser.mutate({ userId: target.id, reason: banReason.trim() })}
              >
                <Ban />
                {m.moderation_ban()}
              </Button>
            </FieldGroup>
          </FieldSet>
        </>
      )}
    </div>
  );
}

/**
 * Closing the case without acting on the target. The success line is not
 * decoration: a dismissal changes nothing visible on the target itself, so
 * without it the only feedback is a button that stops doing anything.
 */
function DismissAction({ detail }: { detail: ModerationCaseDetail }) {
  const resolve = useAtomValue(resolveAtom);
  const [dismissNote, setDismissNote] = useAtom(caseDismissNoteAtom);

  return (
    <FieldSet>
      <FieldLegend variant="label">{m.moderation_dismiss_title()}</FieldLegend>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="case-dismiss-note">{m.moderation_dismiss_note_label()}</FieldLabel>
          <Textarea
            id="case-dismiss-note"
            value={dismissNote}
            onChange={(event) => setDismissNote(event.target.value)}
            placeholder={m.moderation_dismiss_note_placeholder()}
            maxLength={MODERATION_NOTE_MAX_LENGTH}
            className="min-h-16"
          />
          <FieldDescription className="text-right tabular-nums">
            <CharacterCount value={dismissNote} />
          </FieldDescription>
          {resolve.isError && (
            <FieldError>{resolve.error?.message ?? m.moderation_dismiss_error()}</FieldError>
          )}
        </Field>
        {resolve.isSuccess && (
          <Alert>
            <CircleCheck />
            <AlertTitle>{m.moderation_dismiss_done()}</AlertTitle>
          </Alert>
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
          <CheckCheck />
          {m.moderation_dismiss()}
        </Button>
      </FieldGroup>
    </FieldSet>
  );
}

/**
 * "142/500" under a reason box. Every one of these fields is capped by
 * `MODERATION_NOTE_MAX_LENGTH` and `maxLength` silently swallows the
 * keystrokes past it — a moderator writing a considered reason deserves to
 * see the ceiling coming rather than discover it mid-word.
 */
function CharacterCount({ value }: { value: string }) {
  return (
    <>
      {String(value.length)}/{String(MODERATION_NOTE_MAX_LENGTH)}
    </>
  );
}
