import type { Html5QrcodeSupportedFormats } from "html5-qrcode";

/**
 * How the camera scanner is set up (#875, #1476, #1506) — pure, so the camera configuration is tested
 * without a camera.
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
  const edge = Math.round(Math.min(viewfinderWidth, viewfinderHeight) * 0.7);
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
