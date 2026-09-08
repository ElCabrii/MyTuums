import { lazy, Suspense, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Loader2, Pencil, X } from "lucide-react";
import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import {
  hydrateProfileEditAtom,
  imageUploadingAtom,
  profileBioDraftAtom,
  profileNameDraftAtom,
} from "@/atoms/profile-edit";
import { viewerAtom } from "@/atoms/session";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ErrorBanner } from "@/components/error-banner";
import { localizeAuthError } from "@/lib/auth-error-message";
import { m } from "@/paraglide/messages.js";

const ProfileSection = lazy(() =>
  import("@/components/settings/profile-section").then((mod) => ({ default: mod.ProfileSection })),
);

/** The profile owns this editor's lifetime; images save immediately, text on Save. */
export function ProfileEditDialog() {
  const [open, setOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const viewer = useAtomValue(viewerAtom);
  const name = useAtomValue(profileNameDraftAtom);
  const bio = useAtomValue(profileBioDraftAtom);
  const pending = useAtomValue(authPendingAtom);
  const uploading = useAtomValue(imageUploadingAtom);
  const error = useAtomValue(authErrorAtom);
  const setError = useSetAtom(authErrorAtom);
  const hydrate = useSetAtom(hydrateProfileEditAtom);
  const busy = pending || uploading !== null;

  function changeOpen(next: boolean) {
    if (busy) return;
    if (!next && (name !== (viewer?.name ?? "") || bio !== (viewer?.bio ?? ""))) {
      setConfirmDiscard(true);
      return;
    }
    if (next) hydrate();
    setError(null);
    setConfirmDiscard(false);
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={<Button variant="outline" size="icon" className="size-11 rounded-full" />}
        aria-label={m.profile_edit()}
        title={m.profile_edit()}
      >
        <Pencil className="size-4" />
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto rounded-3xl p-4 sm:max-w-xl sm:p-6"
        showCloseButton={false}
      >
        <DialogHeader className="pr-10">
          <DialogTitle className="text-xl font-semibold">{m.profile_edit()}</DialogTitle>
          <DialogDescription>{m.settings_profile_description()}</DialogDescription>
        </DialogHeader>
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-3 right-3"
          aria-label={m.common_close()}
          disabled={busy}
          onClick={() => changeOpen(false)}
        >
          <X className="size-4" />
        </Button>
        {error && <ErrorBanner message={localizeAuthError(error)} />}
        {confirmDiscard && (
          <div role="alert" className="bg-muted sticky top-0 z-10 space-y-3 rounded-2xl border p-4">
            <p>{m.profile_discard_prompt()}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setConfirmDiscard(false)}>
                {m.profile_keep_editing()}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setConfirmDiscard(false);
                  setOpen(false);
                }}
              >
                {m.profile_discard()}
              </Button>
            </div>
          </div>
        )}
        <Suspense
          fallback={
            <Loader2
              className="mx-auto size-6 animate-spin"
              aria-label={m.profile_editor_loading()}
            />
          }
        >
          <ProfileSection
            onSaved={() => {
              setConfirmDiscard(false);
              setOpen(false);
            }}
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
