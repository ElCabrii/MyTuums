import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { POST_REPORT_REASONS, USER_REPORT_REASONS } from "@my-tuums/api/constants";
import {
  reportAtom,
  reportDialogAtom,
  reportReasonAtom,
  resetReportFormEffect,
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
import { m } from "@/paraglide/messages.js";

/**
 * The report flow, one dialog app-wide. Mounted at the root layout and bound
 * to the shared `reportDialogAtom`, so a kebab on any card and the profile
 * menu open the same instance — never two stacked dialogs. The reason picker
 * resets per open via `resetReportFormEffect`: the effect re-runs whenever the
 * target atom's value changes (null → target), so every open starts fresh even
 * though the dialog itself stays mounted for the app's lifetime.
 */
export function ReportDialog() {
  useAtomValue(resetReportFormEffect);
  const target = useAtomValue(reportDialogAtom);
  const setTarget = useSetAtom(reportDialogAtom);
  const report = useAtomValue(reportAtom);
  const [reason, setReason] = useAtom(reportReasonAtom);
  // The stable reason codes come from the shared constants — the same set the
  // server validates against, so the picker can never offer an invalid one.
  const reasons = target?.targetType === "user" ? USER_REPORT_REASONS : POST_REPORT_REASONS;

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) setTarget(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {target?.targetType === "user"
              ? m.moderation_report_title_user()
              : m.moderation_report_title_post()}
          </DialogTitle>
          <DialogDescription>{m.moderation_report_choose()}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 pb-6">
          <Select value={reason} onValueChange={(value) => setReason(value ?? "")}>
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
            <p className="text-sm text-muted-foreground">{m.moderation_report_done()}</p>
          ) : (
            <>
              {report.isError && (
                <p role="alert" className="text-xs text-destructive">
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
                    report.mutate({
                      targetType: "post",
                      targetId: target.targetId,
                      reason: trimmed as (typeof POST_REPORT_REASONS)[number],
                    });
                  } else {
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
    </Dialog>
  );
}
