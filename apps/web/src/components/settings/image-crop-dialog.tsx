import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { IMAGE_LIMITS, type ImageKind } from "@my-tuums/api/constants";
import {
  calculateCropFrame,
  calculateCropRect,
  clampCrop,
  DEFAULT_CROP,
  type Crop,
  type ImageSize,
} from "@/lib/media";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";

/**
 * The crop/reposition editor for one image slot (issue #151).
 *
 * Shown after a file is picked and before the upload commits. The person drags
 * to pan and scrolls to zoom inside a frame of the slot's exact aspect; on
 * Apply the chosen `Crop` is handed back so the caller can bake it into the
 * display variant (`createDisplayVariant(file, kind, crop)`). The original file
 * is never touched here — the crop is a view, not a mutation.
 *
 * The image is decoded twice on purpose: `createImageBitmap` for the oriented
 * dimensions the math needs (the same primitive `lib/media.ts` uses, and the
 * one tests can stub), and an object URL for the `<img>` that actually shows
 * it. The frame's aspect is fixed, so the `<img>` is sized and offset in
 * percentages of the frame — no measurement of the rendered frame is needed.
 */

/** The most the editor will zoom in; beyond this a crop is a sub-pixel sliver. */
const MAX_CROP_SCALE = 8;

/** Wheel zoom step: one notch in or out. */
const ZOOM_STEP = 1.1;

/**
 * The center guaranteed to survive common responsive profile frames.
 *
 * The narrow edge is a 320px phone over the 192px mobile banner (5:3); the
 * wide edge is a 1920px desktop over the 256px banner (7.5:1). Relative to the
 * canonical 3:1 source, those frames retain 5/9 of its width and 2/5 of its
 * height respectively. Wider or narrower exceptional viewports can crop more.
 */
const BANNER_SAFE_AREA = { width: `${(5 / 9) * 100}%`, height: "40%" } as const;

export function ImageCropDialog({
  kind,
  file,
  onApply,
  onCancel,
}: {
  kind: ImageKind;
  file: File;
  onApply: (crop: Crop) => void;
  onCancel: () => void;
}) {
  const [crop, setCrop] = useState<Crop>(DEFAULT_CROP);
  const [failed, setFailed] = useState(false);

  /**
   * The decoded source and its preview URL, resolved together.
   *
   * One piece of state rather than two because they are useless apart: the
   * `<img>` cannot be positioned without the dimensions, and the dimensions
   * have nothing to show without the URL. Setting them in one go also keeps
   * the URL's creation inside the effect that revokes it — allocating it in a
   * `useMemo` would be unsafe under StrictMode, which runs the calculation
   * twice in development and discards one result, leaking a URL that pins the
   * whole file until the page unloads.
   */
  const [source, setSource] = useState<{ dims: ImageSize; url: string } | null>(null);
  const dims = source?.dims ?? null;

  /**
   * The crop frame, held in state rather than a plain ref: the dialog's popup
   * is portalled, so the node does not exist when this component's first
   * effects run. A ref would leave the wheel listener below permanently
   * unattached; state re-runs the effect the moment the node mounts.
   */
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const frameRef = useCallback((node: HTMLDivElement | null) => setFrame(node), []);

  /** The preview box has the exact aspect that will be encoded. */
  const frameAspect = dims
    ? (() => {
        const box = calculateCropFrame(dims, kind);
        return box.width / box.height;
      })()
    : IMAGE_LIMITS[kind].maxWidth / IMAGE_LIMITS[kind].maxHeight;
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    crop: Crop;
    frameWidth: number;
    frameHeight: number;
  } | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    createImageBitmap(file, { imageOrientation: "from-image" })
      .then((bitmap) => {
        // Closed on both paths: a bitmap holds decoded pixels outside the JS
        // heap (up to 50 MP here), so a cancelled decode that simply returned
        // would strand hundreds of megabytes per choose-and-cancel cycle.
        const dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        // The URL is minted only once the decode has succeeded, so a cancelled
        // or failed pick never allocates one to leak.
        if (cancelled) return;
        objectUrl = URL.createObjectURL(file);
        setSource({ dims: dimensions, url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  useEffect(() => {
    if (!frame || !dims) return;
    const onWheel = (event: WheelEvent) => {
      // The page must not scroll while the person is zooming the crop.
      event.preventDefault();
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      // A functional update rather than a captured `crop`: the listener
      // outlives many renders, and reading the state it was attached with
      // would make every notch zoom from the same starting scale.
      setCrop((current) =>
        clampCrop(
          {
            x: current.x,
            y: current.y,
            scale: Math.min(Math.max(current.scale * factor, 1), MAX_CROP_SCALE),
          },
          dims,
          kind,
        ),
      );
    };
    // Not React's `onWheel`: React attaches wheel passively at the root, so a
    // passive handler cannot `preventDefault()` and the page would scroll
    // behind the dialog while the person zooms.
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [dims, frame, kind]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!dims || !frame) return;
    const rect = frame.getBoundingClientRect();
    // A frame with no laid-out size would turn every drag delta into a
    // division by zero; there is nothing to pan against, so ignore the press.
    if (rect.width === 0 || rect.height === 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      crop,
      frameWidth: rect.width,
      frameHeight: rect.height,
    };
    frame.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || !dims || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // Dragging the image by (dx, dy) moves the crop rect by (-dx, -dy) in
    // frame space; one frame width is one crop-rect width, so the normalized
    // center shifts by that fraction of the rect's normalized size.
    const rect = calculateCropRect(dims, kind, drag.crop);
    const x = drag.crop.x - (dx / drag.frameWidth) * (rect.width / dims.width);
    const y = drag.crop.y - (dy / drag.frameHeight) * (rect.height / dims.height);
    setCrop(clampCrop({ x, y, scale: drag.crop.scale }, dims, kind));
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  const label = kind === "avatar" ? m.settings_avatar_label() : m.settings_banner_label();

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className={cn(
          "max-h-[calc(100dvh-2rem)] overflow-y-auto [&>*]:shrink-0",
          kind === "banner" && "max-w-5xl",
        )}
      >
        <DialogHeader>
          <DialogTitle>{m.settings_image_crop_title({ label })}</DialogTitle>
          <DialogDescription>{m.settings_image_crop_hint()}</DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-2">
          {failed ? (
            <p className="text-destructive text-sm">{m.validation_image_unreadable()}</p>
          ) : (
            <div
              ref={frameRef}
              className="bg-muted relative w-full touch-none overflow-hidden rounded-lg select-none"
              style={{ aspectRatio: `${frameAspect}` }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
            >
              {source && (
                <>
                  <img
                    src={source.url}
                    alt=""
                    draggable={false}
                    className="absolute max-w-none"
                    style={imageStyle(source.dims, kind, crop)}
                  />
                  <div
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute top-1/2 left-1/2 border border-white/90 shadow-[0_0_0_9999px_rgb(0_0_0/0.28)]",
                      kind === "avatar" && "rounded-full",
                    )}
                    style={{
                      width: kind === "avatar" ? "100%" : BANNER_SAFE_AREA.width,
                      height: kind === "avatar" ? "100%" : BANNER_SAFE_AREA.height,
                      transform: "translate(-50%, -50%)",
                    }}
                  />
                </>
              )}
            </div>
          )}
          {kind === "banner" && !failed && (
            <p className="text-muted-foreground mt-2 text-xs">
              {m.settings_banner_crop_safe_area()}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {m.common_cancel()}
          </Button>
          <Button type="button" onClick={() => onApply(crop)} disabled={!dims}>
            {m.settings_image_crop_apply()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The `<img>`'s size and offset, as percentages of the frame, so the crop rect
 * fills the frame exactly. `rect` has the frame's aspect, so one scale factor
 * maps it to both axes; the negative offset slides the image so the rect's
 * top-left lands on the frame's top-left.
 */
function imageStyle(
  dims: { width: number; height: number },
  kind: ImageKind,
  crop: Crop,
): CSSProperties {
  const rect = calculateCropRect(dims, kind, crop);
  return {
    width: `${(dims.width / rect.width) * 100}%`,
    height: `${(dims.height / rect.height) * 100}%`,
    left: `${(-rect.x / rect.width) * 100}%`,
    top: `${(-rect.y / rect.height) * 100}%`,
  };
}
