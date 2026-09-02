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
  minCropScale,
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
 * Neither slot zooms out past its default window: that window is the largest
 * aspect-true rectangle inside the source, already spanning its full width or
 * its full height (`minCropScale`). The crop frame stays fixed for both slots;
 * dragging and zooming move the source beneath it. A banner keeps the wider
 * source context visible around its centered 3:1 frame, while an avatar keeps
 * the compact circular viewport treatment.
 *
 * The image is decoded twice on purpose: `createImageBitmap` for the oriented
 * dimensions the math needs (the same primitive `lib/media.ts` uses, and the
 * one tests can stub), and an object URL for the `<img>` that actually shows
 * it. Every preview uses an aspect derived from decoded dimensions, so the
 * image and crop can be positioned in percentages without measuring layout.
 */

/** The most the editor will zoom in; beyond this a crop is a sub-pixel sliver. */
const MAX_CROP_SCALE = 8;

/** Wheel zoom step: one notch in or out. */
const ZOOM_STEP = 1.1;

/** Leaves room for the dialog header and actions without shrinking the source preview arbitrarily. */
const BANNER_PREVIEW_MAX_HEIGHT_DVH = 55;

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

  /** Banners show the source context; avatars use the exact encoded aspect. */
  const frameAspect = dims
    ? kind === "banner"
      ? dims.width / dims.height
      : (() => {
          const box = calculateCropFrame(dims, kind);
          return box.width / box.height;
        })()
    : IMAGE_LIMITS[kind].maxWidth / IMAGE_LIMITS[kind].maxHeight;
  const dragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
    pendingX: number;
    pendingY: number;
    crop: Crop;
    cropFrameWidth: number;
    cropFrameHeight: number;
    animationFrameId: number | null;
  } | null>(null);
  /**
   * The crop every writer sees, mirroring the state. The wheel listener below
   * outlives many renders, so the `crop` it closed over would be the one it
   * attached with — and a functional `setCrop` update cannot rebase the drag
   * anchor, because the updater must stay pure. Every path that sets the state
   * writes this ref too, so the two can never disagree.
   */
  const cropRef = useRef(crop);

  /** Applies only the latest pointer position and rebases at every rendered frame. */
  const applyPendingDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag || !dims) return;
    drag.animationFrameId = null;

    const dx = drag.pendingX - drag.lastX;
    const dy = drag.pendingY - drag.lastY;
    const rect = calculateCropRect(dims, kind, drag.crop);
    const next = clampCrop(
      {
        x: drag.crop.x - (dx / drag.cropFrameWidth) * (rect.width / dims.width),
        y: drag.crop.y - (dy / drag.cropFrameHeight) * (rect.height / dims.height),
        scale: drag.crop.scale,
      },
      dims,
      kind,
    );

    drag.lastX = drag.pendingX;
    drag.lastY = drag.pendingY;
    drag.crop = next;
    const changed =
      next.x !== cropRef.current.x ||
      next.y !== cropRef.current.y ||
      next.scale !== cropRef.current.scale;
    cropRef.current = next;
    if (changed) setCrop(next);
  }, [dims, kind]);

  const flushPendingDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.animationFrameId !== null) {
      cancelAnimationFrame(drag.animationFrameId);
    }
    applyPendingDrag();
  }, [applyPendingDrag]);

  useEffect(
    () => () => {
      const animationFrameId = dragRef.current?.animationFrameId;
      if (animationFrameId !== null && animationFrameId !== undefined) {
        cancelAnimationFrame(animationFrameId);
      }
    },
    [],
  );

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
      flushPendingDrag();
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      // Zoom from the latest descriptor, not the one this listener attached
      // with: reading a captured `crop` would make every notch zoom from the
      // same starting scale. The floor is the slot's default window
      // (`minCropScale`) — below it the window would leave the source.
      const next = clampCrop(
        {
          x: cropRef.current.x,
          y: cropRef.current.y,
          scale: Math.min(
            Math.max(cropRef.current.scale * factor, minCropScale(dims, kind)),
            MAX_CROP_SCALE,
          ),
        },
        dims,
        kind,
      );
      cropRef.current = next;
      setCrop(next);
      // Zooming mid-drag must not strand the drag on the descriptor captured
      // at pointer-down: the next pointer-move would pan at the pre-zoom scale
      // and revert the zoom the person just chose. Rebase the anchor onto the
      // zoomed descriptor — and onto the pointer's current position, because
      // the zoomed crop already includes every pixel panned so far and the
      // move delta must not count them twice.
      const drag = dragRef.current;
      if (drag) {
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        drag.pendingX = event.clientX;
        drag.pendingY = event.clientY;
        drag.crop = next;
      }
    };
    // Not React's `onWheel`: React attaches wheel passively at the root, so a
    // passive handler cannot `preventDefault()` and the page would scroll
    // behind the dialog while the person zooms.
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [dims, flushPendingDrag, frame, kind]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!dims || !frame) return;
    const previewRect = frame.getBoundingClientRect();
    const fixedCropRect = calculateCropRect(dims, kind, DEFAULT_CROP);
    const cropFrameWidth =
      kind === "banner"
        ? previewRect.width * (fixedCropRect.width / dims.width)
        : previewRect.width;
    const cropFrameHeight =
      kind === "banner"
        ? previewRect.height * (fixedCropRect.height / dims.height)
        : previewRect.height;
    // A frame with no laid-out size would turn every drag delta into a
    // division by zero; there is nothing to pan against, so ignore the press.
    if (cropFrameWidth === 0 || cropFrameHeight === 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      pendingX: event.clientX,
      pendingY: event.clientY,
      // The ref rather than the rendered `crop`: a wheel notch in the same
      // frame as this press may not have re-rendered yet, and the drag must
      // start from the descriptor the person is actually looking at.
      crop: cropRef.current,
      cropFrameWidth,
      cropFrameHeight,
      animationFrameId: null,
    };
    frame.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.pendingX = event.clientX;
    drag.pendingY = event.clientY;
    if (drag.animationFrameId === null) {
      drag.animationFrameId = requestAnimationFrame(applyPendingDrag);
    }
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.pendingX = event.clientX;
    drag.pendingY = event.clientY;
    flushPendingDrag();
    dragRef.current = null;
  }

  function onPointerCancel(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.animationFrameId !== null) cancelAnimationFrame(drag.animationFrameId);
    dragRef.current = null;
  }

  const label = kind === "avatar" ? m.settings_avatar_label() : m.settings_banner_label();
  const frameStyle: CSSProperties = { aspectRatio: `${frameAspect}` };
  if (kind === "banner" && dims) {
    frameStyle.width = `min(100%, ${BANNER_PREVIEW_MAX_HEIGHT_DVH * frameAspect}dvh)`;
  }

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
              className="bg-muted relative mx-auto w-full cursor-grab touch-none overflow-hidden rounded-lg select-none active:cursor-grabbing"
              style={frameStyle}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerCancel}
            >
              {source && (
                <>
                  <img
                    src={source.url}
                    alt=""
                    draggable={false}
                    className="absolute max-w-none will-change-transform"
                    style={imageStyle(source.dims, kind, crop)}
                  />
                  {kind === "avatar" ? (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-1/2 rounded-full border border-white/90 shadow-[0_0_0_9999px_rgb(0_0_0/0.28)]"
                      style={{
                        width: "100%",
                        height: "100%",
                        transform: "translate(-50%, -50%)",
                      }}
                    />
                  ) : (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute rounded-lg border border-white/90 shadow-[0_0_0_9999px_rgb(0_0_0/0.38)]"
                      style={fixedCropFrameStyle(source.dims)}
                    />
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {m.common_cancel()}
          </Button>
          <Button type="button" onClick={() => onApply(cropRef.current)} disabled={!dims}>
            {m.settings_image_crop_apply()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Maps the selected source rectangle onto the fixed crop frame. Width and
 * height describe the source only and stay unchanged while interacting;
 * compositor-only transforms handle every pan and zoom frame.
 */
function imageStyle(
  dims: { width: number; height: number },
  kind: ImageKind,
  crop: Crop,
): CSSProperties {
  const fixedCropRect = calculateCropRect(dims, kind, DEFAULT_CROP);
  const cropRect = calculateCropRect(dims, kind, crop);
  const previewRect =
    kind === "banner" ? { x: 0, y: 0, width: dims.width, height: dims.height } : fixedCropRect;
  const scaleX = fixedCropRect.width / cropRect.width;
  const scaleY = fixedCropRect.height / cropRect.height;
  const width = (dims.width / previewRect.width) * 100;
  const height = (dims.height / previewRect.height) * 100;
  const left = ((fixedCropRect.x - cropRect.x * scaleX - previewRect.x) / previewRect.width) * 100;
  const top = ((fixedCropRect.y - cropRect.y * scaleY - previewRect.y) / previewRect.height) * 100;
  return {
    width: `${width}%`,
    height: `${height}%`,
    left: "0%",
    top: "0%",
    transform: `translate3d(${(left / width) * 100}%, ${(top / height) * 100}%, 0) scale(${scaleX}, ${scaleY})`,
    transformOrigin: "top left",
  };
}

/** Positions the fixed 3:1 crop frame over the full-source banner preview. */
function fixedCropFrameStyle(dims: ImageSize): CSSProperties {
  const rect = calculateCropRect(dims, "banner", DEFAULT_CROP);
  return {
    width: `${(rect.width / dims.width) * 100}%`,
    height: `${(rect.height / dims.height) * 100}%`,
    left: `${(rect.x / dims.width) * 100}%`,
    top: `${(rect.y / dims.height) * 100}%`,
  };
}
