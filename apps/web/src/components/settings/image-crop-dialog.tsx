import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { IMAGE_LIMITS, type ImageKind } from "@my-tuums/api/constants";
import { calculateCropRect, clampCrop, type Crop } from "@/lib/media";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [crop, setCrop] = useState<Crop>({ x: 0.5, y: 0.5, scale: 1 });
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);

  /**
   * The crop frame, held in state rather than a plain ref: the dialog's popup
   * is portalled, so the node does not exist when this component's first
   * effects run. A ref would leave the wheel listener below permanently
   * unattached; state re-runs the effect the moment the node mounts.
   */
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const frameRef = useCallback((node: HTMLDivElement | null) => setFrame(node), []);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    crop: Crop;
    frameWidth: number;
    frameHeight: number;
  } | null>(null);

  const aspect = IMAGE_LIMITS[kind].maxWidth / IMAGE_LIMITS[kind].maxHeight;

  // The `<img>`'s source. Derived rather than stored in an effect: the URL is a
  // pure function of the file, and the effect below owns only its revocation.
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  useEffect(() => {
    let cancelled = false;
    createImageBitmap(file, { imageOrientation: "from-image" })
      .then((bitmap) => {
        if (cancelled) return;
        setDims({ width: bitmap.width, height: bitmap.height });
        bitmap.close();
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
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
          aspect,
        ),
      );
    };
    // Not React's `onWheel`: React attaches wheel passively at the root, so a
    // passive handler cannot `preventDefault()` and the page would scroll
    // behind the dialog while the person zooms.
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [aspect, dims, frame]);

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
    const rect = calculateCropRect(dims, aspect, drag.crop);
    const x = drag.crop.x - (dx / drag.frameWidth) * (rect.width / dims.width);
    const y = drag.crop.y - (dy / drag.frameHeight) * (rect.height / dims.height);
    setCrop(clampCrop({ x, y, scale: drag.crop.scale }, dims, aspect));
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  const label = kind === "avatar" ? m.settings_avatar_label() : m.settings_banner_label();

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className={kind === "banner" ? "max-w-2xl" : undefined}>
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
              style={{ aspectRatio: `${aspect}` }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
            >
              {dims && (
                <img
                  src={url}
                  alt=""
                  draggable={false}
                  className="absolute max-w-none"
                  style={imageStyle(dims, aspect, crop)}
                />
              )}
            </div>
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
  aspect: number,
  crop: Crop,
): CSSProperties {
  const rect = calculateCropRect(dims, aspect, crop);
  return {
    width: `${(dims.width / rect.width) * 100}%`,
    height: `${(dims.height / rect.height) * 100}%`,
    left: `${(-rect.x / rect.width) * 100}%`,
    top: `${(-rect.y / rect.height) * 100}%`,
  };
}
