import { useState } from "react";
import { ImagePlus } from "lucide-react";
import { ALLOWED_IMAGE_TYPES, VIDEO_INPUT_TYPES, VIDEO_MAX_BYTES } from "@my-tuums/api/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { m } from "@/paraglide/messages.js";

export function ComposerMediaDialog({
  disabled,
  onSelect,
  description,
  hints,
}: {
  disabled: boolean;
  onSelect: (files: File[]) => void;
  /**
   * Optional copy overrides for hosts whose media rules differ from the post
   * composer's (the message composer allows a voice note and forbids nothing
   * about posts). Defaults stay the post wording, so every existing caller is
   * unchanged.
   */
  description?: string;
  hints?: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const resolvedHints = hints ?? [
    m.post_images_hint(),
    m.video_input_hint({ maxMb: String(VIDEO_MAX_BYTES / 1_000_000) }),
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button type="button" variant="outline" size="sm" className="rounded-full" />}
        aria-label={m.post_add_media()}
        disabled={disabled}
      >
        <ImagePlus className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">{m.post_add_media()}</span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.post_add_media()}</DialogTitle>
          <DialogDescription>{description ?? m.post_media_hint()}</DialogDescription>
        </DialogHeader>
        <label className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed p-5 text-center text-sm">
          <ImagePlus className="text-muted-foreground size-8" aria-hidden="true" />
          <span>{m.post_media_choose()}</span>
          <Input
            type="file"
            accept={[...ALLOWED_IMAGE_TYPES, ...VIDEO_INPUT_TYPES].join(",")}
            multiple
            disabled={disabled}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length === 0) return;
              onSelect(files);
              setOpen(false);
            }}
          />
        </label>
        <div className="text-muted-foreground space-y-2 text-xs">
          {resolvedHints.map((hint) => (
            <p key={hint}>{hint}</p>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
