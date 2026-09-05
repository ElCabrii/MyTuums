/**
 * Measures the caret line inside a textarea through a hidden mirror div
 * (issue #336): the mirror copies the textarea's wrapping-relevant styles,
 * renders the text before the caret plus a zero-width marker, and the
 * marker's offsets are read back as the caret line's geometry.
 *
 * Only the prefix matters: the caret's position within its line depends
 * solely on the text before it on that line, and the line's vertical
 * position solely on the lines before it — trailing text moves neither.
 */
export interface CaretLine {
  /** Line top edge, in px from the textarea's border-box top. */
  top: number;
  /** Line height, in px. */
  lineHeight: number;
  /** Line bottom edge relative to the viewport, in px. */
  viewportBottom: number;
}

/**
 * The computed-style properties that decide where text wraps and how tall a
 * line is. Copied onto the mirror so its layout matches the textarea's;
 * `whiteSpace` is included because a div defaults to collapsing whitespace
 * while a textarea preserves and wraps it.
 */
const COPIED_PROPERTIES = [
  "boxSizing",
  "width",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "whiteSpace",
  "wordWrap",
  "overflowWrap",
] as const;

/** The marker's content: zero width, but it still occupies the line's height. */
const MARKER_TEXT = "\u200b"; // explicit escape: a literal zero-width space would be invisible in review

export function measureCaretLine(textarea: HTMLTextAreaElement, caretIndex: number): CaretLine {
  const caret = Math.max(0, Math.min(caretIndex, textarea.value.length));
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const mirrorStyle = mirror.style;
  mirrorStyle.position = "absolute";
  mirrorStyle.visibility = "hidden";
  mirrorStyle.top = "0";
  mirrorStyle.left = "0";
  mirrorStyle.whiteSpace = "pre-wrap";
  // A long unbroken prefix must wrap exactly like the textarea wraps it —
  // without this the marker lands on a line the real caret never reaches.
  mirrorStyle.wordWrap = "break-word";
  for (const property of COPIED_PROPERTIES) {
    mirrorStyle[property] = computed[property];
  }
  mirror.append(document.createTextNode(textarea.value.slice(0, caret)));
  const marker = document.createElement("span");
  marker.textContent = MARKER_TEXT;
  mirror.append(marker);
  document.body.append(mirror);
  try {
    // A parsed `line-height` beats the marker's box: the marker can collapse
    // to zero (empty inline boxes do in some engines), while the computed
    // value is the line grid the text actually sits on.
    const lineHeight = Number.parseFloat(computed.lineHeight) || marker.offsetHeight || 0;
    const top = marker.offsetTop;
    return {
      top,
      lineHeight,
      viewportBottom: textarea.getBoundingClientRect().top + top - textarea.scrollTop + lineHeight,
    };
  } finally {
    mirror.remove();
  }
}
