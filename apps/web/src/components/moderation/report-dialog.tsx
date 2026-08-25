import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { POST_REPORT_REASONS, USER_REPORT_REASONS } from "@my-tuums/api/constants";
import {
  reportAtom,
  reportDialogAtom,
  reportReasonAtom,
  resetReportFormEffect,
  type ReportDialogTarget,
} from "@/atoms/moderation";
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
import { reasonLabel } from "@/components/moderation/labels";
import { PostAttachmentGrid } from "@/components/post-attachment-grid";
import type { Post } from "@/lib/orpc";
import { m } from "@/paraglide/messages.js";

/**
 * The report flow, one dialog app-wide. Mounted at the root layout and bound
 * to the shared `reportDialogAtom`, so a kebab on any card and the profile
 * menu open the same instance — never two stacked dialogs.
 *
 * The form lives in `ReportDialogBody`, mounted only while a target is set:
 * the mutation atom is read there, so closing the dialog unmounts its last
 * subscriber and the mutation observer resets. A success or error from one
 * report therefore never leaks into the next open — the dialog used to stay
 * stuck on "Thanks — we'll look into it." for the rest of the page load,
 * because the root-mounted dialog kept the observer alive forever.
 */
export function ReportDialog() {
  const target = useAtomValue(reportDialogAtom);
  const setTarget = useSetAtom(reportDialogAtom);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) setTarget(null);
      }}
    >
      {target && <ReportDialogBody target={target} />}
    </Dialog>
  );
}

/** The data-backed half of the report dialog — mounted only while a target is set. */
function ReportDialogBody({ target }: { target: ReportDialogTarget }) {
  useAtomValue(resetReportFormEffect);
  const report = useAtomValue(reportAtom);
  const [reason, setReason] = useAtom(reportReasonAtom);
  // The stable reason codes come from the shared constants — the same set the
  // server validates against, so the picker can never offer an invalid one.
  const reasons = target.targetType === "user" ? USER_REPORT_REASONS : POST_REPORT_REASONS;

  return (
    <DialogContent className="max-h-[85dvh] gap-0 overflow-y-auto p-0">
      <DialogHeader className="bg-popover border-border sticky top-0 z-10 border-b">
        <DialogTitle>
          {target.targetType === "user"
            ? m.moderation_report_title_user()
            : m.moderation_report_title_post()}
        </DialogTitle>
        <DialogDescription>{m.moderation_report_choose()}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 px-6 pt-5 pb-6">
        {/* The post being reported, so the reporter confirms what they are
            flagging before picking a reason. A user target has no post. */}
        {target.targetType === "post" && <ReportPreview post={target.post} />}
        {/* `items` is what makes the trigger read "Hate speech" once a reason
            is picked: Base UI renders the raw code otherwise. */}
        <Select
          items={Object.fromEntries(reasons.map((code) => [code, reasonLabel(code)]))}
          value={reason}
          onValueChange={(value) => setReason(value ?? "")}
        >
          {/* The trigger's only text is the placeholder rendered inside the
                combobox, which is content, not a label — without this the
                picker would have no accessible name at all. */}
          <SelectTrigger aria-label={m.moderation_report_choose()} className="w-full">
            <SelectValue placeholder={m.moderation_report_choose()} />
          </SelectTrigger>
          <SelectContent>
            {reasons.map((code) => (
              <SelectItem key={code} value={code}>
                {reasonLabel(code)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {report.isSuccess ? (
          <p className="text-muted-foreground text-sm">{m.moderation_report_done()}</p>
        ) : (
          <>
            {report.isError && (
              <p role="alert" className="text-destructive text-xs">
                {m.moderation_report_error()}
              </p>
            )}
            <Button
              className="w-full"
              disabled={!reason || report.isPending}
              onClick={() => {
                if (!target) return;
                // Narrow the target onto one of the schema's discriminated
                // variants — each carries its own reason-code set (the same
                // literal-resolution the case family does). The value came
                // from the Select items, so the cast is the schema's own
                // union, not a coercion.
                const trimmed = reason.trim();
                if (target.targetType === "post") {
                  // SAFETY: the Select items are built off the same literal reason
                  // list, so the cast is the schema's own union, not a coercion.
                  report.mutate({
                    targetType: "post",
                    targetId: target.targetId,
                    reason: trimmed as (typeof POST_REPORT_REASONS)[number],
                  });
                } else {
                  // SAFETY: the Select items are built off the same literal reason
                  // list, so the cast is the schema's own union, not a coercion.
                  report.mutate({
                    targetType: "user",
                    targetId: target.targetId,
                    reason: trimmed as (typeof USER_REPORT_REASONS)[number],
                  });
                }
              }}
            >
              {report.isPending ? m.moderation_report_submitting() : m.moderation_report_submit()}
            </Button>
          </>
        )}
      </div>
    </DialogContent>
  );
}

/**
 * The post being reported, shown above the reason picker so the reporter
 * confirms what they are flagging. Plain text rather than `LinkedText`: this
 * is a confirmation preview, not a place to navigate away to a profile, and
 * the appeal preview (`appeal-page.tsx`) renders the same way. The full
 * `PostAttachmentGrid` — links and all — is fine here because the dialog body
 * is not a button, unlike the queue row.
 *
 * The "no text" line is guarded on having attachments: a removed post reaches
 * the kebab with null content and no attachments (the regular projection
 * hides them), and telling the reporter "images only" with no images below
 * would be a lie about what is gone.
 */
function ReportPreview({ post }: { post: Post }) {
  return (
    <div className="border-border/60 bg-muted/30 space-y-2 rounded-lg border p-3 text-left">
      <p className="text-muted-foreground text-xs font-medium">
        {m.moderation_report_preview_title()}
      </p>
      {post.content ? (
        <p className="text-foreground/90 text-sm leading-relaxed break-words whitespace-pre-line">
          {post.content}
        </p>
      ) : post.attachments.length > 0 ? (
        <p className="text-muted-foreground text-sm italic">
          {m.moderation_report_preview_no_text()}
        </p>
      ) : null}
      <PostAttachmentGrid attachments={post.attachments} />
    </div>
  );
}
