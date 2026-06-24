/**
 * Caret-aware popup positioning for the KB markdown editor autocompletes (issue #797).
 *
 * The `[[slug]]` and `{{ lazyit_secret.HANDLE }}` suggestion popups were pinned to the editor's
 * top-left (`absolute left-2 top-2`), so they covered the very lines being typed. Instead we anchor
 * each popup just *below the caret's line* — so the text you are typing stays visible — using the
 * standard hidden-mirror-`<div>` technique to read the caret's pixel position out of a `<textarea>`.
 *
 * Two layers, deliberately split so the geometry can be unit-tested without a DOM:
 *  - `placePopupBelowCaret` — PURE clamp/layout math (tested in `textarea-caret.test.ts`).
 *  - `caretCoordinates` / `caretPopupPosition` — the DOM-touching mirror-div measurement.
 */

/** A caret's pixel rectangle inside the textarea's content box (origin = textarea's own border box). */
export interface CaretRect {
  /** Distance from the textarea's top to the caret's line top, already minus `scrollTop`. */
  top: number;
  /** Distance from the textarea's left to the caret, already minus `scrollLeft`. */
  left: number;
  /** The caret line's height (line-height in px) — the popup sits below this. */
  height: number;
}

/** The clamped popup offset, in px, relative to the editor's positioned container. */
export interface PopupPosition {
  top: number;
  left: number;
}

/**
 * Pure layout: given the caret rect, the textarea box and the popup width, return the popup's
 * `{ top, left }` so it sits just under the caret line, fully inside the box, never covering the
 * active line. `gap` is the small space between the caret line and the popup top.
 *
 * - Vertically: prefer just *below* the caret line; if that would overflow the bottom, flip to just
 *   *above* the caret line (so a caret near the bottom still doesn't cover its own text).
 * - Horizontally: align the popup's left to the caret, then clamp so it never spills past the right
 *   edge (and never goes negative).
 */
export function placePopupBelowCaret(
  caret: CaretRect,
  box: { width: number; height: number },
  popup: { width: number; height: number },
  gap = 4,
): PopupPosition {
  // Horizontal: anchor at the caret, clamp into [0, box.width - popup.width].
  const maxLeft = Math.max(0, box.width - popup.width);
  const left = Math.min(Math.max(0, caret.left), maxLeft);

  // Vertical: below the caret line by default; flip above if it would overflow the bottom.
  const below = caret.top + caret.height + gap;
  const fitsBelow = below + popup.height <= box.height;
  const above = caret.top - gap - popup.height;
  const top = fitsBelow ? below : Math.max(0, above);

  return { top, left };
}

/**
 * The textarea style properties the mirror `<div>` must copy verbatim so its glyph layout matches
 * the textarea 1:1. Anything affecting wrapping, advance width, or the content box belongs here.
 */
const MIRRORED_STYLES = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "whiteSpace",
  "wordBreak",
  "wordWrap",
  "overflowWrap",
  "tabSize",
] as const;

/**
 * Measure the caret's pixel position inside a `<textarea>` via a hidden mirror `<div>`: a div that
 * copies the textarea's box + typography, holds the text up to the caret, and a zero-width marker
 * `<span>` at the caret. The span's offset is the caret's position relative to the content; we add
 * the textarea's padding/border and subtract its scroll to get a rect in the textarea's border box.
 *
 * Returns `null` when there is no layout to measure (no `window`, e.g. SSR). Self-cleaning: the
 * mirror is appended to `<body>` and removed before returning, so it never lingers in the DOM.
 */
export function caretCoordinates(
  textarea: HTMLTextAreaElement,
  caretIndex: number,
): CaretRect | null {
  if (typeof window === "undefined") return null;

  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const cs = mirror.style;

  // Off-screen, same wrapping as the textarea. The textarea scrolls; the mirror does not.
  cs.position = "absolute";
  cs.visibility = "hidden";
  cs.top = "0";
  cs.left = "-9999px";
  cs.overflow = "hidden";
  for (const prop of MIRRORED_STYLES) {
    cs[prop] = style[prop];
  }
  // The textarea wraps; the mirror must too (textareas are always `pre-wrap`-like).
  cs.whiteSpace = "pre-wrap";
  cs.wordWrap = "break-word";

  const value = textarea.value;
  // Text up to the caret as a text node; a marker span at the caret; remaining text after it so the
  // line the caret is on keeps its full height (e.g. an empty trailing line still measures a row).
  mirror.textContent = value.slice(0, caretIndex);
  const marker = document.createElement("span");
  marker.textContent = value.slice(caretIndex) || ".";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
  const rect: CaretRect = {
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    height: lineHeight,
  };
  document.body.removeChild(mirror);
  return rect;
}

/**
 * Convenience: measure the caret and lay the popup out below its line, clamped to the textarea box.
 * Returns `null` when the caret can't be measured (SSR / detached node) so callers can fall back to
 * a static anchor. `popupWidth`/`popupHeight` are the popup's max box (matching its CSS caps) so the
 * clamp keeps it on-screen even before it has rendered/measured itself.
 */
export function caretPopupPosition(
  textarea: HTMLTextAreaElement,
  caretIndex: number,
  popup: { width: number; height: number },
): PopupPosition | null {
  const caret = caretCoordinates(textarea, caretIndex);
  if (!caret) return null;
  return placePopupBelowCaret(
    caret,
    { width: textarea.clientWidth, height: textarea.clientHeight },
    popup,
  );
}
