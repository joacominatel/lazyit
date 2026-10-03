"use client";

import type { Html5Qrcode } from "html5-qrcode";
import { useEffect, useRef, useState } from "react";
import {
  type CameraScanMode,
  cameraScanConfig,
  feedbackOnRead,
  msUntilFeedbackChange,
  SCAN_FORMATS,
  type ScanFeedback,
  type ScanFeedbackState,
  scanFeedback,
  startFeedback,
} from "@/lib/utils/camera-scan";

/** Where the camera is: starting, reading, refused/failed, or not available at all on this device. */
export type CameraScanStatus = "starting" | "scanning" | "error" | "unsupported";

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
 * and desktop Firefox where the native `BarcodeDetector` is not available (Chrome on macOS has it, and the
 * library alternates it with its own decoder). The library is loaded only when the scanner mounts, and the
 * camera stops when it unmounts. The camera, formats and scan box come from `cameraScanConfig` (#1506).
 *
 * `readerId` is the DOM node the library mounts its `<video>` into: render it — inside a `CameraViewfinder`,
 * which lays it out at the decode width — while the status is `starting` or `scanning`. `onDecode` runs for
 * every read — the library reports the same code on every frame it sees it, so a caller that keeps scanning
 * de-duplicates. Its `stop` argument ends the session early (a one-shot lookup that already has its answer);
 * it returns `true` when it took the read (a new serial, the asset to open), which flashes the success
 * feedback and gives a short vibration where the device has one.
 *
 * `feedback` is what the viewfinder shows while scanning (`null` otherwise): reading, a just-taken read, or
 * a tip once nothing has been seen for a few seconds.
 *
 * Progressive enhancement: the camera needs permission and a secure (HTTPS) context. Without the API the
 * status is `unsupported`; a refusal, a missing camera or an insecure origin is `error`. Callers always keep
 * a typed fallback.
 */
export function useCameraScanner(
  readerId: string,
  onDecode: (text: string, stop: () => void) => boolean | void,
  mode: CameraScanMode = "qr",
): { status: CameraScanStatus; feedback: ScanFeedback | null } {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  // The latest callback, so a parent re-render never restarts the camera.
  const onDecodeRef = useRef(onDecode);
  const [status, setStatus] = useState<CameraScanStatus>("starting");
  // The feedback state and the time it was last evaluated at — time only moves on a read or a timer.
  const [clock, setClock] = useState<{ state: ScanFeedbackState; now: number } | null>(null);

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
      const instance = new Html5Qrcode(readerId, {
        verbose: false,
        formatsToSupport: SCAN_FORMATS.map((name) => F[name]),
        useBarCodeDetectorIfSupported: true,
      });
      scannerRef.current = instance;
      try {
        await instance.start(
          // Ignored by the library when `videoConstraints` is given, but required.
          { facingMode: "environment" },
          cameraScanConfig(mode),
          (decodedText) => {
            const taken = onDecodeRef.current(decodedText, () => void stopQuietly(instance)) === true;
            if (taken) navigator.vibrate?.(40);
            const at = Date.now();
            setClock((prev) => {
              if (!prev) return prev;
              const state = feedbackOnRead(prev.state, at, taken);
              return state === prev.state ? prev : { state, now: at };
            });
          },
          undefined,
        );
        if (cancelled) {
          await stopQuietly(instance);
          return;
        }
        setStatus("scanning");
        const at = Date.now();
        setClock({ state: startFeedback(at), now: at });
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

  // Re-evaluate the feedback when it changes on its own: the success flash ends, or the tip is due.
  useEffect(() => {
    if (!clock) return;
    const wait = msUntilFeedbackChange(clock.state, clock.now);
    if (wait === null) return;
    const timer = setTimeout(() => setClock((prev) => prev && { ...prev, now: Date.now() }), wait);
    return () => clearTimeout(timer);
  }, [clock]);

  return {
    status,
    feedback: status === "scanning" && clock ? scanFeedback(clock.state, clock.now) : null,
  };
}
