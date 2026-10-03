import type { Html5QrcodeSupportedFormats } from "html5-qrcode";

/**
 * How the camera scanner is set up and how it tells the operator what it is doing (#875, #1476, #1506) —
 * pure, so the camera configuration and the feedback timing are tested without a camera.
 *
 * `html5-qrcode` decodes a canvas the size of its scan box **in layout pixels**, not in camera pixels: a
 * viewfinder laid out 430 px wide is decoded at about 390 px whatever the camera delivers, too few pixels
 * per bar for a Code 128 serial or a small QR label held where a laptop webcam (fixed focus) is sharp
 * (#1506). So the viewfinder is laid out at {@link DECODE_WIDTH} and scaled down only for display
 * ({@link viewfinderFit}), and the camera is asked for HD ({@link CAPTURE_CONSTRAINTS}).
 */

/**
 * What to read:
 *   - `qr`       — the asset label lookup (#875): a square box for the QR label; a plain asset-tag barcode
 *     sticker still reads and becomes a search;
 *   - `barcodes` — the serial numbers on hardware boxes (#1476): a wide, short box, read across the bars.
 */
export type CameraScanMode = "qr" | "barcodes";

/** A format by its `Html5QrcodeSupportedFormats` name — the enum itself is loaded with the library. */
export type ScanFormatName = keyof typeof Html5QrcodeSupportedFormats;

/**
 * The codes both modes read: QR and Data Matrix, and the 1D codes printed on hardware boxes and tag
 * stickers. The library's default is all seventeen formats, so every frame also ran the Aztec, Codabar,
 * MaxiCode, PDF417, RSS and UPC/EAN-extension readers for nothing.
 */
export const SCAN_FORMATS: readonly ScanFormatName[] = [
  "QR_CODE",
  "DATA_MATRIX",
  "CODE_128",
  "CODE_39",
  "CODE_93",
  "EAN_13",
  "EAN_8",
  "UPC_A",
  "UPC_E",
  "ITF",
];

/** The width the viewfinder is laid out — and so decoded — at, in CSS pixels; it is scaled down to fit. */
export const DECODE_WIDTH = 1280;

/**
 * The camera request: the rear camera where there is one, in HD. Without a size the browser opens 640×480.
 * `ideal`, never `exact`: a camera that cannot reach it opens at its best instead of failing.
 */
export const CAPTURE_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "environment",
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

/** Decode attempts per second — each waits for the previous one, so a slow device scans less often. */
export const SCAN_FPS = 10;

/**
 * The largest QR box edge, in layout pixels. A QR label needs far fewer pixels than a row of bars, and the box
 * is decoded in full on the main thread, so a portrait phone stream (1280 × 2276 laid out) stays at 640² rather
 * than 896².
 */
export const QR_BOX_MAX_EDGE = 640;

/** The scan box inside a viewfinder of the given layout size: wide and short for 1D codes, square for QR. */
export function scanBox(
  mode: CameraScanMode,
  viewfinderWidth: number,
  viewfinderHeight: number,
): { width: number; height: number } {
  if (mode === "barcodes") {
    return {
      width: Math.round(viewfinderWidth * 0.9),
      height: Math.round(Math.min(viewfinderHeight * 0.5, viewfinderWidth * 0.45)),
    };
  }
  const edge = Math.min(Math.round(Math.min(viewfinderWidth, viewfinderHeight) * 0.7), QR_BOX_MAX_EDGE);
  return { width: edge, height: edge };
}

/**
 * The `Html5Qrcode.start()` configuration for a mode. `disableFlip`: on a failed frame the library otherwise
 * flips the canvas transform and decodes the **same pixels** a second time (the flip only lands on the next
 * frame), doubling the work per frame for nothing — camera frames are never mirrored, the 1D readers already
 * read both directions, and the QR reader handles a mirrored code itself.
 */
export function cameraScanConfig(mode: CameraScanMode) {
  return {
    fps: SCAN_FPS,
    disableFlip: true,
    videoConstraints: CAPTURE_CONSTRAINTS,
    qrbox: (viewfinderWidth: number, viewfinderHeight: number) => scanBox(mode, viewfinderWidth, viewfinderHeight),
  };
}

/**
 * Scale the viewfinder laid out at {@link DECODE_WIDTH} to the width it is shown at: the CSS scale, the height
 * its frame takes once scaled (`0` while the video has no size yet), and — when that is taller than
 * `maxHeight` (a portrait phone camera) — the frame is capped and the video shifted up by `offsetY`, so the
 * frame shows its middle, where the scan box is.
 */
export function viewfinderFit(
  displayWidth: number,
  layoutHeight: number,
  maxHeight: number = Number.POSITIVE_INFINITY,
): { scale: number; height: number; offsetY: number } {
  const scale = displayWidth > 0 ? displayWidth / DECODE_WIDTH : 0;
  const full = Math.round(layoutHeight * scale);
  const height = Math.min(full, Math.round(maxHeight));
  return { scale, height, offsetY: Math.round((full - height) / 2) };
}

/**
 * What the scanner shows while the camera runs:
 *   - `reading` — looking for a code;
 *   - `success` — a code was just taken (a short flash);
 *   - `tip`     — nothing has been seen for {@link SCAN_TIP_AFTER_MS}: how to get a read, or to type it.
 */
export type ScanFeedback = "reading" | "success" | "tip";

/** How long nothing must be seen before the tip shows, in ms. */
export const SCAN_TIP_AFTER_MS = 6000;
/** How long the success flash lasts, in ms. */
export const SCAN_SUCCESS_MS = 1200;
/** A code seen again within this window does not restart the tip clock (the library reports every frame). */
const SIGHTING_REFRESH_MS = 1000;

/** When the camera last saw a code (or started), and when a read was last taken. */
export interface ScanFeedbackState {
  since: number;
  successAt: number | null;
}

/** The camera has just started reading. */
export function startFeedback(now: number): ScanFeedbackState {
  return { since: now, successAt: null };
}

/**
 * A code was seen. `taken` when the caller used it (a new serial, the asset to open) — that flashes; a code
 * still in view or already in the list only keeps the tip away. Returns the same state when nothing changes,
 * so the 10 reads a second of a code held in view do not re-render.
 */
export function feedbackOnRead(state: ScanFeedbackState, now: number, taken: boolean): ScanFeedbackState {
  if (taken) return { since: now, successAt: now };
  if (now - state.since < SIGHTING_REFRESH_MS) return state;
  return { ...state, since: now };
}

/** What to show at `now`. */
export function scanFeedback(state: ScanFeedbackState, now: number): ScanFeedback {
  if (state.successAt !== null && now - state.successAt < SCAN_SUCCESS_MS) return "success";
  if (now - state.since >= SCAN_TIP_AFTER_MS) return "tip";
  return "reading";
}

/** In how many ms {@link scanFeedback} changes on its own, or `null` when it waits for the next read. */
export function msUntilFeedbackChange(state: ScanFeedbackState, now: number): number | null {
  const changes: number[] = [];
  if (state.successAt !== null && now - state.successAt < SCAN_SUCCESS_MS) {
    changes.push(state.successAt + SCAN_SUCCESS_MS - now);
  }
  if (now - state.since < SCAN_TIP_AFTER_MS) changes.push(state.since + SCAN_TIP_AFTER_MS - now);
  return changes.length > 0 ? Math.min(...changes) : null;
}
