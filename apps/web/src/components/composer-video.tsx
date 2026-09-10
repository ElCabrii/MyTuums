import { useAtomValue, useSetAtom } from "jotai";
import { Film, X } from "lucide-react";
import {
  clearVideoDraft,
  resumeVideoUploadAtomFamily,
  videoDraftAtomFamily,
} from "@/atoms/video-upload";
import { Button } from "@/components/ui/button";
import { LocalVideoPreview } from "@/components/local-video-preview";
import { m } from "@/paraglide/messages.js";

export function ComposerVideo({ scope, disabled }: { scope: string; disabled: boolean }) {
  const draft = useAtomValue(videoDraftAtomFamily(scope));
  const resume = useSetAtom(resumeVideoUploadAtomFamily(scope));
  if (!draft) return null;
  return (
    <div className="bg-muted/30 w-full space-y-3 rounded-lg p-3">
      <div className="flex items-center gap-2">
        <Film className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm">{draft.file.name}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={m.video_remove()}
          disabled={disabled}
          onClick={() => clearVideoDraft(scope, true)}
        >
          <X />
        </Button>
      </div>
      <LocalVideoPreview key={draft.selectionId} file={draft.file} />
      <div role="status" className="text-muted-foreground text-xs">
        {draft.status === "uploaded"
          ? m.video_uploaded()
          : draft.status === "paused"
            ? m.video_upload_paused()
            : m.video_upload_progress({
                percent: String(Math.min(100, Math.floor((draft.bytes / draft.file.size) * 100))),
              })}
      </div>
      {draft.status !== "uploaded" && (
        <progress
          className="accent-primary h-2 w-full"
          max={draft.file.size}
          value={draft.bytes}
          aria-label={m.video_upload_label()}
        />
      )}
      {draft.status === "paused" && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            void resume();
          }}
        >
          {m.video_resume()}
        </Button>
      )}
      <p className="text-muted-foreground text-xs">{m.video_input_hint()}</p>
    </div>
  );
}
