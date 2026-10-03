"use client";

import { CheckCircleIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { DECODE_WIDTH, type ScanFeedback, viewfinderFit } from "@/lib/utils/camera-scan";

/** The most of the screen's height the viewfinder takes. */
const MAX_VIEWPORT_SHARE = 0.6;

/**
 * The frame `useCameraScanner` mounts the camera into (#1506). `html5-qrcode` decodes its scan box at the
 * viewfinder's **layout** size, so the reader is laid out at {@link DECODE_WIDTH} — enough pixels per bar
 * for a serial barcode or a small QR label — and scaled down to the frame's width for display only.
 *
 * Over the video: a "scanning" badge while it reads, and a check with a green ring when a code is taken.
 * Both are visual only (`aria-hidden`); the caller's `aria-live` status line says the same in words.
 */
export function CameraViewfinder({
  readerId,
  feedback,
  scanningLabel,
  className,
}: {
  readerId: string;
  feedback: ScanFeedback | null;
  /** The badge text while reading ("Scanning…"). */
  scanningLabel: string;
  className?: string;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const scalerRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 0, height: 0, offsetY: 0 });

  useEffect(() => {
    const frame = frameRef.current;
    const scaler = scalerRef.current;
    if (!frame || !scaler || typeof ResizeObserver === "undefined") return;
    // The frame's width sets the scale; the scaler's height (the video's, once it has a size) sets the frame's,
    // up to 60% of the screen so a portrait phone camera doesn't push the rest of the form away.
    const update = () => {
      // No video: not started yet (the 16:9 placeholder holds), or stopped after a read — the library removes
      // its video then, and the frame keeps its last size instead of jumping.
      if (scaler.offsetHeight === 0) return;
      const next = viewfinderFit(frame.clientWidth, scaler.offsetHeight, window.innerHeight * MAX_VIEWPORT_SHARE);
      setFit((prev) =>
        prev.scale === next.scale && prev.height === next.height && prev.offsetY === next.offsetY ? prev : next,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    observer.observe(scaler);
    // The cap follows the screen: rotating a phone or resizing the window changes it.
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    // The border and rounding (`className`) go on the outside, so the measured frame's height is all video.
    <div className={cn("w-full overflow-hidden bg-muted", className)}>
      <div
        ref={frameRef}
        className="relative w-full overflow-hidden"
        // Until the video has a size, hold a 16:9 frame so the layout doesn't jump.
        style={fit.height > 0 ? { height: fit.height } : { aspectRatio: "16 / 9" }}
      >
        {/* Absolutely placed, so its 1280 px never widen the dialog or page around it; the library makes the
            reader itself `position: relative`, hence the wrapper. */}
        <div
          ref={scalerRef}
          className="absolute top-0 left-0"
          style={{
            width: DECODE_WIDTH,
            transform: `translateY(${-fit.offsetY}px) scale(${fit.scale})`,
            transformOrigin: "0 0",
          }}
        >
          <div id={readerId} />
        </div>
        {feedback === "reading" || feedback === "tip" ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-background/85 px-2 py-0.5 text-xs font-medium text-foreground shadow-sm"
          >
            <span className="size-2 rounded-full bg-success motion-safe:animate-pulse" />
            {scanningLabel}
          </span>
        ) : null}
        {feedback === "success" ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-success/15 ring-4 ring-success ring-inset motion-safe:animate-in motion-safe:fade-in"
          >
            <CheckCircleIcon className="size-14 rounded-full bg-background/85 text-success" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
