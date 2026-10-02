"use client";

import type { Html5Qrcode } from "html5-qrcode";
import { useEffect, useRef, useState } from "react";

/** Where the camera is: starting, reading, refused/failed, or not available at all on this device. */
export type CameraScanStatus = "starting" | "scanning" | "error" | "unsupported";

/**
 * What to read:
 *   - `qr`       — QR codes in a square box (the asset label lookup, #875);
 *   - `barcodes` — QR plus the 1D and 2D codes printed on hardware boxes (Code 128 / 39 / 93, EAN, UPC, ITF,
 *     Data Matrix) in a wide box, for serial numbers (#1476).
 */
export type CameraScanMode = "qr" | "barcodes";

/** The part of an `Html5Qrcode` instance a teardown touches. */
export interface StoppableScanner {
  stop: () => Promise<unknown>;
  clear?: () => void;
}

/**
 * Stop a scanner without ever throwing. `Html5Qrcode.stop()` throws SYNCHRONOUSLY when it is not scanning —
 * a start still pending or one that failed (camera refused, no HTTPS) — and a throw in an effect cleanup
 * reaches the error boundary on unmount. Both the synchronous throw and the rejected promise are swallowed:
 * a scanner that cannot stop has nothing left to release. With `clear`, the injected viewfinder is removed
 * once stopped.
 */
export function stopQuietly(instance: StoppableScanner, { clear = false }: { clear?: boolean } = {}): Promise<void> {
  let stopped: Promise<unknown>;
  try {
    stopped = Promise.resolve(instance.stop());
  } catch {
    return Promise.resolve();
  }
  return stopped
    .then(() => {
      if (clear) instance.clear?.();
    })
    .catch(() => {});
}

/**
 * The device camera through `html5-qrcode` (#875) — one cross-browser decoder, so it works on mobile Safari
 * and desktop Firefox where the native `BarcodeDetector` is not available. The library is loaded only when
 * the scanner mounts, and the camera stops when it unmounts.
 *
 * `readerId` is the DOM node the library mounts its `<video>` into: render it while the status is
 * `starting` or `scanning`. `onDecode` runs for every read — the library reports the same code on every
 * frame it sees it, so a caller that keeps scanning de-duplicates. Its `stop` argument ends the session
 * early (a one-shot lookup that already has its answer).
 *
 * Progressive enhancement: the camera needs permission and a secure (HTTPS) context. Without the API the
 * status is `unsupported`; a refusal, a missing camera or an insecure origin is `error`. Callers always keep
 * a typed fallback.
 */
export function useCameraScanner(
  readerId: string,
  onDecode: (text: string, stop: () => void) => void,
  mode: CameraScanMode = "qr",
): CameraScanStatus {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  // The latest callback, so a parent re-render never restarts the camera.
  const onDecodeRef = useRef(onDecode);
  const [status, setStatus] = useState<CameraScanStatus>("starting");

  useEffect(() => {
    onDecodeRef.current = onDecode;
  }, [onDecode]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // No camera API (older browser, insecure context, or a headless environment) → the typed fallback.
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setStatus("unsupported");
        return;
      }
      const { Html5Qrcode, Html5QrcodeSupportedFormats: F } = await import("html5-qrcode");
      if (cancelled) return;
      const instance = new Html5Qrcode(
        readerId,
        mode === "barcodes"
          ? {
              verbose: false,
              formatsToSupport: [
                F.QR_CODE,
                F.CODE_128,
                F.CODE_39,
                F.CODE_93,
                F.EAN_13,
                F.EAN_8,
                F.UPC_A,
                F.UPC_E,
                F.ITF,
                F.DATA_MATRIX,
              ],
              useBarCodeDetectorIfSupported: true,
            }
          : undefined,
      );
      scannerRef.current = instance;
      try {
        await instance.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              if (mode === "barcodes") {
                // A wide, short box: a 1D barcode is read across its bars.
                return {
                  width: Math.floor(viewfinderWidth * 0.9),
                  height: Math.floor(Math.min(viewfinderHeight * 0.5, viewfinderWidth * 0.45)),
                };
              }
              const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7);
              return { width: edge, height: edge };
            },
          },
          (decodedText) => onDecodeRef.current(decodedText, () => void stopQuietly(instance)),
          undefined,
        );
        if (cancelled) {
          await stopQuietly(instance);
          return;
        }
        setStatus("scanning");
      } catch {
        // Permission denied, no camera, or an insecure (non-HTTPS) origin — all land here.
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      const instance = scannerRef.current;
      scannerRef.current = null;
      if (instance) void stopQuietly(instance, { clear: true });
    };
  }, [readerId, mode]);

  return status;
}
