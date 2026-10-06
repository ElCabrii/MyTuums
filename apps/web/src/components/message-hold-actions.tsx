import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { m } from "@/paraglide/messages.js";

/** Touch holds reveal actions, never execute them. Desktop keeps its hover controls. */
export function MessageHoldActions({
  children,
  className,
  enabled,
  actions,
}: {
  children: ReactNode;
  className: string;
  enabled: boolean;
  actions: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const suppressClick = useRef(false);
  const touch = useRef(false);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
    held.current = false;
  };
  useEffect(() => cancel, []);
  useLayoutEffect(() => {
    if (!open) return;
    // Mobile browsers can synthesize a click after pointerup, retargeted to
    // the new dialog. Consume that release, but allow the next deliberate
    // press (including outside dismissal) and keyboard activation normally.
    const nextPress = () => {
      suppressClick.current = false;
    };
    const releaseClick = (event: MouseEvent) => {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("pointerdown", nextPress, true);
    document.addEventListener("click", releaseClick, true);
    return () => {
      document.removeEventListener("pointerdown", nextPress, true);
      document.removeEventListener("click", releaseClick, true);
    };
  }, [open]);

  return (
    <>
      <div
        className={`${className} max-md:select-none max-md:[-webkit-touch-callout:none]`}
        onPointerDown={(event) => {
          cancel();
          suppressClick.current = false;
          touch.current = false;
          if (
            !enabled ||
            event.pointerType !== "touch" ||
            !event.isPrimary ||
            !window.matchMedia("(width < 48rem)").matches
          )
            return;
          // Players, links and image viewers keep their own native interactions.
          if (event.target instanceof Element && event.target.closest("a,button,input,video,audio"))
            return;
          touch.current = true;
          origin.current = { x: event.clientX, y: event.clientY };
          timer.current = setTimeout(() => {
            held.current = true;
            timer.current = null;
          }, 500);
        }}
        onPointerMove={(event) => {
          if (
            origin.current &&
            Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 10
          )
            cancel();
        }}
        onPointerUp={(event) => {
          const reveal = held.current;
          cancel();
          if (reveal) {
            // Mount after release so the original finger cannot dismiss the
            // dialog or land on a newly revealed destructive action.
            event.preventDefault();
            suppressClick.current = true;
            setOpen(true);
          }
        }}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onContextMenu={(event) => {
          if (touch.current && enabled && window.matchMedia("(width < 48rem)").matches)
            event.preventDefault();
        }}
      >
        {children}
        {enabled && (
          <Button
            variant="ghost"
            className="sr-only focus:not-sr-only md:hidden"
            onClick={() => setOpen(true)}
          >
            {m.messages_actions()}
          </Button>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{m.messages_actions()}</DialogTitle>
          </DialogHeader>
          {actions(() => setOpen(false))}
        </DialogContent>
      </Dialog>
    </>
  );
}
