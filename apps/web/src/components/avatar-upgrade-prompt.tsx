import { useEffect, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ImageUp, Loader2, X } from "lucide-react";
import { imageUploadingAtom, uploadImageAtom } from "@/atoms/profile-edit";
import { avatarUpgradeDismissalAtom } from "@/atoms/avatar-upgrade";
import { isBelowAvatarDisplayCeiling, measureImageWidth } from "@/lib/avatar-upgrade";
import { Button } from "@/components/ui/button";
import { ImageCropDialog } from "@/components/settings/image-crop-dialog";
import { m } from "@/paraglide/messages.js";

/**
 * The one-click re-crop offer for an avatar still at the pre-#233 ceiling.
 *
 * Rendered by `ProfileLayout` on the owner's own profile only. Everything it
 * needs already exists: the retained original (the session carries its
 * `/media` path as `imageOriginal`) is what the crop editor
 * (`settings/image-crop-dialog.tsx`) is seeded from, and `uploadImageAtom`
 * re-encodes the chosen crop at today's ceiling — the same pipeline a fresh
 * upload runs, so the crop stays the person's choice rather than a silent
 * re-encode that would recompose their picture (issue #246).
 *
 * Detection measures the display variant against the live ceiling
 * (`lib/avatar-upgrade.ts`); the prompt renders only once a measurement has
 * landed, so a slow image never flashes the offer.
 */
export function AvatarUpgradePrompt({
  avatarUrl,
  originalUrl,
}: {
  /** The display variant currently on the profile. */
  avatarUrl: string;
  /** The untouched original's `/media` path, or null when there is none to crop from. */
  originalUrl: string | null;
}) {
  const [dismissedUrl, setDismissedUrl] = useAtom(avatarUpgradeDismissalAtom);
  const uploading = useAtomValue(imageUploadingAtom);
  const upload = useSetAtom(uploadImageAtom);

  /**
   * The measurement for one avatar URL, held with the URL it belongs to — a
   * slow load for a previous picture must never answer for the current one.
   * `width: null` means the measurement failed: a broken or unmeasurable image
   * says nothing about the stored resolution, so the only safe reading is
   * "no prompt".
   */
  const [measurement, setMeasurement] = useState<{ url: string; width: number | null } | null>(
    null,
  );

  /** The original fetched as a File, waiting on the crop editor — or null when it is closed. */
  const [source, setSource] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void measureImageWidth(avatarUrl).then((width) => {
      if (!cancelled) setMeasurement({ url: avatarUrl, width });
    });
    return () => {
      cancelled = true;
    };
  }, [avatarUrl]);

  // The prompt renders only once this URL's own measurement has landed, so a
  // slow image never flashes the offer.
  const measuredWidth = measurement?.url === avatarUrl ? measurement.width : undefined;
  if (measuredWidth === undefined || measuredWidth === null) return null;
  if (!isBelowAvatarDisplayCeiling(measuredWidth)) return null;
  // Without an original there is nothing to seed the editor from — OAuth
  // provider pictures are exactly this case, and their fix is a fresh upload.
  if (!originalUrl) return null;
  if (dismissedUrl === avatarUrl) return null;

  /** Both image controls lock while either slot uploads (see `profile-edit.ts`). */
  const isBusy = uploading !== null;

  /** Brings the untouched original into the editor as the File it decodes. */
  async function openRecrop() {
    if (!originalUrl) return;
    setError(null);
    try {
      const response = await fetch(originalUrl);
      if (!response.ok) throw new Error(`Original fetch failed: ${response.status}`);
      const blob = await response.blob();
      setSource(new File([blob], "avatar-original", { type: blob.type }));
    } catch {
      // The original could not be brought in — a failed redirect, a lost
      // session, a network blip. The offer stays up so a retry is one click
      // away; the settings page's Choose control remains the other path.
      setError(m.avatar_upgrade_failed());
    }
  }

  return (
    <>
      <div className="border-border/60 bg-muted/40 mb-4 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <ImageUp aria-hidden="true" className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{m.avatar_upgrade_title()}</p>
            <p className="text-muted-foreground text-sm">{m.avatar_upgrade_body()}</p>
            {error && (
              <p role="alert" className="text-destructive text-xs">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={m.avatar_upgrade_dismiss()}
            disabled={isBusy}
            onClick={() => setDismissedUrl(avatarUrl)}
          >
            <X aria-hidden="true" className="h-4 w-4" />
            {m.avatar_upgrade_dismiss()}
          </Button>
          <Button type="button" size="sm" disabled={isBusy} onClick={() => void openRecrop()}>
            {isBusy ? (
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
            ) : (
              <ImageUp aria-hidden="true" className="h-4 w-4" />
            )}
            {m.avatar_upgrade_action()}
          </Button>
        </div>
      </div>

      {source && (
        <ImageCropDialog
          kind="avatar"
          file={source}
          onApply={(crop) => {
            setSource(null);
            void upload({ kind: "avatar", file: source, crop }).then((ok) => {
              if (!ok) setError(m.common_something_went_wrong());
            });
          }}
          onCancel={() => setSource(null)}
        />
      )}
    </>
  );
}
