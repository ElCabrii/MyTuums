import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, Image as ImageIcon, Loader2, Trash2, Upload, UserRound } from "lucide-react";
import type { ImageKind } from "@my-tuums/api/constants";
import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import { viewerAtom } from "@/atoms/session";
import {
  bioRemainingAtom,
  hydrateProfileEditAtom,
  imageUploadingAtom,
  messageForUploadError,
  profileBioDraftAtom,
  profileNameDraftAtom,
  removeImageAtom,
  resetProfileEditAtom,
  saveProfileAtom,
  uploadImageAtom,
} from "@/atoms/profile-edit";
import { IMAGE_ACCEPT, validateImageFile } from "@/lib/media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/user-avatar";
import { Section } from "@/components/settings/section";
import { ImageCropDialog } from "@/components/settings/image-crop-dialog";
import { m } from "@/paraglide/messages.js";

/**
 * Avatar, banner, display name and bio — everything a profile page renders
 * about a person that they can change.
 *
 * The two images and the two text fields are separate submissions on purpose.
 * An image upload is a slow, all-or-nothing round trip that replaces one thing;
 * folding it into a Save button beside the name would mean either uploading on
 * every save or holding a File in an atom until one, and both make the failure
 * modes worse than the mild inconsistency of two controls.
 */
export function ProfileSection() {
  const viewer = useAtomValue(viewerAtom);
  const [name, setName] = useAtom(profileNameDraftAtom);
  const [bio, setBio] = useAtom(profileBioDraftAtom);
  const bioRemaining = useAtomValue(bioRemainingAtom);
  const isBusy = useAtomValue(authPendingAtom);

  const hydrate = useSetAtom(hydrateProfileEditAtom);
  const reset = useSetAtom(resetProfileEditAtom);
  const save = useSetAtom(saveProfileAtom);

  /**
   * Fill the drafts once, on mount, from the session — and reset them on
   * unmount, the same lifetime rule every other form in this app follows (see
   * atoms/auth-form.ts for why a nested `<Provider>` is not the answer).
   *
   * Deliberately not a derived atom: a derived value would recompute every time
   * the session refetched and overwrite whatever was half-typed.
   */
  useEffect(() => {
    hydrate();
    return reset;
  }, [hydrate, reset]);

  return (
    <Section
      title={m.settings_profile_title()}
      description={m.settings_profile_description()}
      icon={<UserRound className="h-5 w-5" />}
    >
      <div className="space-y-4">
        <ImageRow
          kind="avatar"
          label={m.settings_avatar_label()}
          hint={m.settings_avatar_hint()}
          hasImage={Boolean(viewer?.image)}
          preview={
            <UserAvatar
              user={viewer}
              className="bg-background h-16 w-16 shrink-0"
              fallbackClassName="bg-primary text-primary-foreground font-bold"
            />
          }
        />

        <ImageRow
          kind="banner"
          label={m.settings_banner_label()}
          hint={m.settings_banner_hint()}
          hasImage={Boolean(viewer?.bannerImage)}
          preview={
            <div className="border-border/50 bg-muted h-16 w-28 shrink-0 overflow-hidden rounded-xl border">
              {viewer?.bannerImage && (
                <img
                  src={viewer.bannerImage}
                  alt={m.settings_banner_label()}
                  className="h-full w-full object-cover"
                />
              )}
            </div>
          }
        />
      </div>

      <form
        className="border-border/50 space-y-4 border-t pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="space-y-2">
          <label
            htmlFor="profile-name"
            className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
          >
            {m.auth_field_display_name()}
          </label>
          <Input
            id="profile-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-background/50 h-10"
            autoComplete="name"
            required
          />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="profile-bio"
            className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
          >
            {m.auth_field_bio()}
          </label>
          {/* A plain textarea rather than a `ui/` primitive — there is no
              `ui/textarea.tsx`, and `composer-form.tsx` styles a bare one the
              same way. */}
          <textarea
            id="profile-bio"
            rows={3}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder={m.auth_field_bio_placeholder()}
            className="border-input bg-background/50 focus-visible:ring-ring w-full resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
          {/* Mirrors the composer's counter: only turns destructive once over,
              so it reads as information rather than a warning while typing. */}
          <p
            className={`text-right text-xs ${
              bioRemaining < 0 ? "text-destructive font-medium" : "text-muted-foreground"
            }`}
          >
            {bioRemaining}
          </p>
        </div>

        <Button type="submit" size="sm" className="gap-2 rounded-full" disabled={isBusy}>
          {isBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {m.common_save()}
        </Button>
      </form>
    </Section>
  );
}

/**
 * One image slot: a preview, a Choose button and a Remove button.
 *
 * The file input is hidden and driven by a button rather than styled directly.
 * A bare `<input type="file">` cannot be restyled to match anything else here,
 * and it is the only control in the app that would need `data-testid`-style
 * targeting — so the visible control is a real button with a real accessible
 * name, and the input keeps an `aria-label` for anything driving it directly.
 */
function ImageRow({
  kind,
  label,
  hint,
  hasImage,
  preview,
}: {
  kind: ImageKind;
  label: string;
  hint: string;
  hasImage: boolean;
  preview: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploading = useAtomValue(imageUploadingAtom);
  const upload = useSetAtom(uploadImageAtom);
  const remove = useSetAtom(removeImageAtom);
  const setError = useSetAtom(authErrorAtom);

  /**
   * The file waiting on a crop, or null when the editor is closed.
   *
   * Component state rather than an atom: it lives and dies with this row's
   * dialog, nothing else in the app reads it, and holding a `File` in a
   * module-scoped atom would outlive the form it belongs to.
   */
  const [pending, setPending] = useState<File | null>(null);

  const isUploading = uploading === kind;
  // Both controls lock while *either* slot is uploading: they write the same
  // session, and letting a banner upload land mid-avatar-upload would make the
  // refresh order decide which one appears to have won.
  const isBusy = uploading !== null;

  return (
    <div className="flex items-center gap-4">
      {pending && (
        <ImageCropDialog
          kind={kind}
          file={pending}
          onApply={(crop) => {
            setPending(null);
            void upload({ kind, file: pending, crop });
          }}
          onCancel={() => setPending(null)}
        />
      )}

      {preview}

      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          {label}
        </p>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>

      <div className="flex shrink-0 gap-1.5">
        <input
          ref={inputRef}
          type="file"
          accept={IMAGE_ACCEPT}
          aria-label={label}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset the input's value so picking the *same* file again still
            // fires a change event — otherwise a failed upload cannot be
            // retried without choosing something else first.
            e.target.value = "";
            if (!file) return;
            // Refuse the file the crop editor could never upload — an SVG or an
            // over-cap original — before the dialog opens, with the same copy
            // the upload itself would have produced. There is no crop worth
            // choosing for a file the server will reject on arrival.
            try {
              validateImageFile(file, kind);
            } catch (err) {
              setError(
                messageForUploadError(
                  err instanceof Error ? err : new Error("Image rejected", { cause: err }),
                ),
              );
              return;
            }
            setError(null);
            setPending(file);
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-2 rounded-full"
          disabled={isBusy}
          onClick={() => inputRef.current?.click()}
        >
          {isUploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : kind === "avatar" ? (
            <Upload className="h-3.5 w-3.5" />
          ) : (
            <ImageIcon className="h-3.5 w-3.5" />
          )}
          {m.settings_image_choose()}
        </Button>

        {hasImage && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={m.settings_image_remove_label({ label })}
            disabled={isBusy}
            onClick={() => void remove(kind)}
          >
            <Trash2 className="text-destructive h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
