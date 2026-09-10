/**
 * The vertical placement of the mention/game suggestion panel relative to the
 * caret line (issue #336). Pure geometry — no DOM — so it pins in a node
 * unit test; the measuring half lives in `caret-measure.ts`.
 */
export interface CaretPanelInput {
  /** Caret line top edge, in px from the wrapper's padding-box top. */
  caretTop: number;
  /** Caret line height, in px. */
  lineHeight: number;
  /** Gap between the caret line and the panel, in px. */
  gap: number;
  /** Measured panel height, in px. */
  panelHeight: number;
  /** Caret line bottom edge relative to the viewport, in px. */
  caretViewportBottom: number;
  /** Viewport height, in px. */
  viewportHeight: number;
}

export interface CaretPanelPlacement {
  /** `"below"` opens under the caret line; `"above"` flips over it. */
  side: "above" | "below";
  /** Panel top edge, in px from the wrapper's padding-box top. */
  top: number;
}

/**
 * Picks which side of the caret line the panel opens on and the `top` offset
 * that puts it there. Below is home: it reads as a continuation of the line
 * being typed and matches the pre-#336 position, so the panel flips only when
 * below would overflow the viewport while above fits. When neither side fits
 * it stays below — a clipped panel under the caret beats one hiding the line
 * just typed.
 */
export function caretPanelPlacement(input: CaretPanelInput): CaretPanelPlacement {
  const fitsBelow =
    input.caretViewportBottom + input.gap + input.panelHeight <= input.viewportHeight;
  const fitsAbove =
    input.caretViewportBottom - input.lineHeight - input.gap - input.panelHeight >= 0;
  if (fitsBelow || !fitsAbove) {
    return { side: "below", top: input.caretTop + input.lineHeight + input.gap };
  }
  return { side: "above", top: input.caretTop - input.gap - input.panelHeight };
}
