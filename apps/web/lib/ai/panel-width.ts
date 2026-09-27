/**
 * The AI panel's width (issue #1371): pure rules for the resizable side panel. The panel has a default
 * width that docks beside the page at `xl`; anything wider OVERLAYS the page instead of shrinking it.
 * The width is a per-browser preference kept in `localStorage`.
 */

/** The docked width, and the width a reset or "collapse" returns to. */
export const PANEL_DEFAULT_WIDTH = 400;
/** Narrower than this the approval cards stop fitting. */
export const PANEL_MIN_WIDTH = 360;
/** The widest the panel gets, however wide the screen. */
export const PANEL_MAX_WIDTH = 1100;
/** What the page always keeps visible on the left of a wide panel (room for the rail and a sliver). */
export const PANEL_PAGE_GUTTER = 96;
/** The width the expand toggle opens to, before clamping to the screen. */
export const PANEL_EXPANDED_WIDTH = 720;
/** One arrow-key step on the resize handle; Shift makes it bigger. */
export const PANEL_KEY_STEP = 32;
export const PANEL_KEY_STEP_LARGE = 128;

export const PANEL_WIDTH_STORAGE_KEY = "lazyit.ai.panelWidth";

/** The widest the panel may be on a viewport this wide (never below the minimum). */
export function maxPanelWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return PANEL_MAX_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.floor(viewportWidth - PANEL_PAGE_GUTTER)));
}

/** Clamps a width to `[min, max(viewport)]`, rounding to whole pixels. A non-number reads as the default. */
export function clampPanelWidth(width: number, viewportWidth: number): number {
  const w = Number.isFinite(width) ? Math.round(width) : PANEL_DEFAULT_WIDTH;
  return Math.min(maxPanelWidth(viewportWidth), Math.max(PANEL_MIN_WIDTH, w));
}

/** A panel wider than the docked width overlays the page. */
export function isOverlayWidth(width: number): boolean {
  return width > PANEL_DEFAULT_WIDTH;
}

/** The expand toggle: default ↔ expanded (clamped to the screen). */
export function toggledPanelWidth(width: number, viewportWidth: number): number {
  return isOverlayWidth(width)
    ? PANEL_DEFAULT_WIDTH
    : clampPanelWidth(PANEL_EXPANDED_WIDTH, viewportWidth);
}

/** The width a pointer at `clientX` asks for: the panel is anchored to the right edge. */
export function widthFromPointer(clientX: number, viewportWidth: number): number {
  return clampPanelWidth(viewportWidth - clientX, viewportWidth);
}

/**
 * The resize handle's keyboard (the WAI-ARIA window-splitter pattern). The handle sits on the panel's
 * LEFT edge, so ArrowLeft widens and ArrowRight narrows; Home/End jump to the minimum/maximum and Enter
 * resets to the default. Any other key returns null (not handled).
 */
export function widthForKey(
  key: string,
  shiftKey: boolean,
  width: number,
  viewportWidth: number,
): number | null {
  const step = shiftKey ? PANEL_KEY_STEP_LARGE : PANEL_KEY_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampPanelWidth(width + step, viewportWidth);
    case "ArrowRight":
      return clampPanelWidth(width - step, viewportWidth);
    case "Home":
      return PANEL_MIN_WIDTH;
    case "End":
      return maxPanelWidth(viewportWidth);
    case "Enter":
      return PANEL_DEFAULT_WIDTH;
    default:
      return null;
  }
}

/** A stored preference → a width, or null when absent or not a sane number (tolerant read). */
export function parseStoredPanelWidth(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < PANEL_MIN_WIDTH || n > 10_000) return null;
  return Math.round(n);
}

/** Reads the stored width; any storage failure (private mode, blocked site data) reads as "none". */
export function readStoredPanelWidth(storage: Pick<Storage, "getItem"> | undefined): number | null {
  try {
    return parseStoredPanelWidth(storage?.getItem(PANEL_WIDTH_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Stores the width; a storage failure is ignored (the preference is a convenience). */
export function writeStoredPanelWidth(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  width: number,
): void {
  try {
    if (width === PANEL_DEFAULT_WIDTH) storage?.removeItem(PANEL_WIDTH_STORAGE_KEY);
    else storage?.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Ignored: the width simply isn't remembered.
  }
}
