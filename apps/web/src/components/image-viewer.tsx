import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { m } from "@/paraglide/messages.js";
import { cn } from "@/lib/utils";

interface ImageViewerProps {
  /**
   * The full-size source. The dialog mounts its content only while open, so
   * this request happens when the viewer opens, not when the page renders.
   */
  src: string;
  /** Alt text for the full-size rendering. */
  alt: string;
  /** Accessible name of the dialog. */
  title: string;
  /** sr-only description announced with the title; defaults to the title. */
  description?: string;
  /**
   * Overrides the trigger's accessible name. Without it the name comes from
   * the thumbnail's own alt text.
   */
  triggerLabel?: string;
  /** Per-site shape: rounding, focus-ring colour, background plate. */
  triggerClassName?: string;
  /** The thumbnail rendered inside the trigger button. */
  children: ReactNode;
}

/**
 * One thumbnail backed by an accessible full-size viewer: a trigger opening a
 * modal with the contained, viewport-bounded image, Escape/backdrop/close
 * dismissal, and focus returned to the triggering thumbnail on close.
 *
 * Extracted from the profile avatar dialog so post attachments could share
 * the interaction without duplicating modal details per call site. Built on
 * the generator-owned shadcn dialog primitive — modal mechanics live there.
 */
export function ImageViewer({
  src,
  alt,
  title,
  description,
  triggerLabel,
  triggerClassName,
  children,
}: ImageViewerProps) {
  return (
    <Dialog>
      <DialogTrigger
        aria-label={triggerLabel}
        // Both call sites sit inside click-to-navigate surfaces (the post
        // card's shell navigates to the thread on any unclaimed click). The
        // card also guards against clicks landing on buttons, so this is belt
        // and braces — but the kebab menu sets the same precedent.
        onClick={(event) => event.stopPropagation()}
        className={cn(
          "h-auto w-auto cursor-zoom-in border-0 bg-transparent p-0 outline-none",
          triggerClassName,
        )}
      >
        {children}
      </DialogTrigger>
      {/* Transparent over the darkened backdrop, matching the avatar viewer:
          nothing frames the image but its own rounded corners. */}
      <DialogContent
        className="max-w-4xl overflow-hidden border-none bg-transparent p-2 shadow-none sm:p-4"
        // The dialog is portaled to <body>, but React events still bubble
        // through the React tree — which, from a feed, passes through the
        // post card's click-to-navigate shell. Without this, clicking the
        // image, a loading/error state, or the backdrop would also fire
        // `handleCardClick` and navigate to the thread (the trigger already
        // stops propagation on its own click, but that only covers opening).
        // The portaled `DropdownMenuContent` in `post-card.tsx` sets the same
        // precedent.
        onClick={(event) => event.stopPropagation()}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? title}</DialogDescription>
        </DialogHeader>
        <ViewerBody src={src} alt={alt} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The full-size rendering plus its load states. Lives below the popup so it
 * remounts on every open — the portal unmounts while closed — which resets
 * the load state instead of replaying a stale spinner or error.
 */
function ViewerBody({ src, alt }: { src: string; alt: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  return (
    // Holds a visible size while nothing has loaded yet, so loading and
    // broken-image states never leave an unusable empty modal.
    <div className="flex min-h-48 items-center justify-center">
      {status === "loading" && (
        <p className="text-white">
          <Loader2 aria-hidden className="h-8 w-8 animate-spin motion-reduce:animate-none" />
          <span className="sr-only">{m.image_viewer_loading()}</span>
        </p>
      )}
      {status === "error" && (
        <p role="alert" className="text-sm text-white">
          {m.image_viewer_error()}
        </p>
      )}
      {/* Hidden until loaded so a half-painted frame never flashes. A plain
          <img>, so animated formats keep animating at full size. */}
      <img
        src={src}
        alt={alt}
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("error")}
        className={cn(
          "max-h-[80vh] w-full rounded-xl object-contain",
          status !== "loaded" && "hidden",
        )}
      />
    </div>
  );
}
