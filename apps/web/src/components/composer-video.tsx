import { useAtom, useSetAtom } from "jotai";
import { Film, X } from "lucide-react";
import { VIDEO_CAPTION_MAX_BYTES, VIDEO_INPUT_TYPES } from "@my-tuums/api/constants";
import {
  clearVideoDraft,
  resumeVideoUploadAtomFamily,
  selectVideoAtomFamily,
  videoDraftAtomFamily,
} from "@/atoms/video-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { m } from "@/paraglide/messages.js";

export function ComposerVideo({
  scope,
  disabled,
  onError,
}: {
  scope: string;
  disabled: boolean;
  onError: (message: string | null) => void;
}) {
  const [draft, setDraft] = useAtom(videoDraftAtomFamily(scope));
  const select = useSetAtom(selectVideoAtomFamily(scope));
  const resume = useSetAtom(resumeVideoUploadAtomFamily(scope));
  if (!draft)
    return (
      <label className="border-border text-muted-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50">
        <Film className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">{m.video_add()}</span>
        <input
          type="file"
          accept={VIDEO_INPUT_TYPES.join(",")}
          aria-label={m.video_add()}
          className="sr-only"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onError(select(file) ? null : m.video_input_hint());
          }}
        />
      </label>
    );
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
      <label className="block space-y-1 text-xs">
        <span>{m.video_captions_upload()}</span>
        <Input
          type="file"
          accept=".vtt,text/vtt"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file && (file.size > VIDEO_CAPTION_MAX_BYTES || file.size === 0)) {
              onError(m.video_captions_invalid());
              return;
            }
            setDraft((current) => (current ? { ...current, captions: file } : null));
            onError(null);
          }}
        />
      </label>
      {draft.captions && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="min-w-0 truncate">{draft.captions.name}</span>
          <label className="flex items-center gap-2">
            {m.video_captions_language()}
            <Input
              className="w-24"
              value={draft.captionLanguage}
              maxLength={35}
              disabled={disabled}
              onChange={(event) =>
                setDraft((current) =>
                  current ? { ...current, captionLanguage: event.target.value } : null,
                )
              }
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() =>
              setDraft((current) => (current ? { ...current, captions: undefined } : null))
            }
          >
            {m.video_captions_remove()}
          </Button>
        </div>
      )}
    </div>
  );
}
