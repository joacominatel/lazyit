import { describe, expect, test } from "bun:test";
import {
  CAPTURE_CONSTRAINTS,
  cameraScanConfig,
  DECODE_WIDTH,
  SCAN_FORMATS,
  scanBox,
  viewfinderFit,
} from "./camera-scan";

describe("camera scan setup (#1506)", () => {
  test("reads QR and Data Matrix plus the 1D codes on boxes and tag stickers — not all seventeen formats", () => {
    for (const format of ["QR_CODE", "DATA_MATRIX", "CODE_128", "CODE_39", "EAN_13", "EAN_8", "UPC_A", "UPC_E", "ITF"]) {
      expect(SCAN_FORMATS).toContain(format as (typeof SCAN_FORMATS)[number]);
    }
    for (const format of ["AZTEC", "CODABAR", "MAXICODE", "PDF_417", "RSS_14", "RSS_EXPANDED", "UPC_EAN_EXTENSION"]) {
      expect(SCAN_FORMATS).not.toContain(format as (typeof SCAN_FORMATS)[number]);
    }
  });

  test("asks the camera for HD, as an ideal rather than a requirement, and the rear camera", () => {
    expect(CAPTURE_CONSTRAINTS.facingMode).toBe("environment");
    expect(CAPTURE_CONSTRAINTS.width).toEqual({ ideal: 1920 });
    expect(CAPTURE_CONSTRAINTS.height).toEqual({ ideal: 1080 });
  });

  test("the start config sends the constraints, skips the duplicate flipped decode and keeps 10 fps", () => {
    for (const mode of ["qr", "barcodes"] as const) {
      const config = cameraScanConfig(mode);
      expect(config.videoConstraints).toBe(CAPTURE_CONSTRAINTS);
      expect(config.disableFlip).toBe(true);
      expect(config.fps).toBe(10);
      expect(config.qrbox(1280, 720)).toEqual(scanBox(mode, 1280, 720));
    }
  });

  test("barcodes get a wide, short box; QR a square one", () => {
    expect(scanBox("barcodes", 1280, 720)).toEqual({ width: 1152, height: 360 });
    expect(scanBox("qr", 1280, 720)).toEqual({ width: 504, height: 504 });
    // A portrait phone stream: the barcode box stays wider than tall.
    const portrait = scanBox("barcodes", 1280, 2276);
    expect(portrait.width).toBeGreaterThan(portrait.height);
  });

  test("the viewfinder is laid out at the decode width and scaled down to fit its frame", () => {
    expect(DECODE_WIDTH).toBeGreaterThanOrEqual(1280);
    expect(viewfinderFit(640, 720)).toEqual({ scale: 0.5, height: 360, offsetY: 0 });
    expect(viewfinderFit(448, 0)).toEqual({ scale: 0.35, height: 0, offsetY: 0 });
    expect(viewfinderFit(0, 720)).toEqual({ scale: 0, height: 0, offsetY: 0 });
  });

  test("a tall (portrait) video is capped and centred on its middle, where the scan box is", () => {
    // 1080×1920 laid out 1280 wide is 2276 tall; shown 320 wide that is 569 px.
    expect(viewfinderFit(320, 2276, 400)).toEqual({ scale: 0.25, height: 400, offsetY: 85 });
    expect(viewfinderFit(320, 720, 400)).toEqual({ scale: 0.25, height: 180, offsetY: 0 });
  });
});
