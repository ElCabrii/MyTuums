import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { seenChangelogVersionAtom } from "@/atoms/changelog";
import { legalConsentRequiredAtom } from "@/atoms/legal-consent";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { APP_VERSION } from "@/lib/app-version";
import { shouldShowChangelog, isNewerAppVersion } from "@/lib/changelog";
import { currentChangelogHtml } from "@/lib/changelog-content";
import { m } from "@/paraglide/messages.js";

/** The once-per-release dialog for the Markdown bundled with this app version. */
export function ChangelogDialog({ content = currentChangelogHtml() }: { content?: string | null }) {
  const seenVersion = useAtomValue(seenChangelogVersionAtom);
  const legalConsentRequired = useAtomValue(legalConsentRequiredAtom);
  const markSeen = useSetAtom(seenChangelogVersionAtom);
  const hasContent = content !== null;

  useEffect(() => {
    if (!hasContent && isNewerAppVersion(APP_VERSION, seenVersion)) {
      markSeen(APP_VERSION);
    }
  }, [hasContent, markSeen, seenVersion]);

  if (content === null) return null;

  const open =
    !legalConsentRequired &&
    shouldShowChangelog({ appVersion: APP_VERSION, seenVersion, hasContent: true });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) markSeen(APP_VERSION);
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] max-w-lg p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>{m.changelog_dialog_title({ version: APP_VERSION })}</DialogTitle>
          <DialogDescription>{m.changelog_dialog_description()}</DialogDescription>
        </DialogHeader>
        {/* The HTML is generated at build time from repository-owned Markdown;
            raw HTML in those files makes the build fail. It is never user or
            server input, and no Markdown parser ships to the browser. */}
        <div
          className="[&_p]:text-muted-foreground [&_a]:text-link hover:[&_a]:text-link/80 [&_strong]:text-foreground [&_h2]:first-child:mt-0 max-h-[55dvh] overflow-y-auto px-6 [&_a]:underline [&_a]:underline-offset-2 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-semibold [&_li]:leading-relaxed [&_p]:mb-3 [&_p]:leading-relaxed [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5"
          role="region"
          aria-label={m.changelog_dialog_content_label()}
          tabIndex={0}
          dangerouslySetInnerHTML={{ __html: content }}
        />
        <DialogFooter className="px-6 pb-6">
          <DialogClose render={<Button type="button" className="w-full sm:w-auto" />}>
            {m.changelog_dialog_dismiss()}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
