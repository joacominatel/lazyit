"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { DECODE_WIDTH, viewfinderFit } from "@/lib/utils/camera-scan";

/** The most of the screen's height the viewfinder takes. */
const MAX_VIEWPORT_SHARE = 0.6;

/**
 * The frame `useCameraScanner` mounts the camera into (#1506). `html5-qrcode` decodes its scan box at the
 * viewfinder's **layout** size, so the reader is laid out at {@link DECODE_WIDTH} — enough pixels per bar
 * for a serial barcode or a small QR label — and scaled down to the frame's width for display only.
 */
export function CameraViewfinder({ readerId, className }: { readerId: string; className?: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const scalerRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 0, height: 0, offsetY: 0 });

  useEffect(() => {
    const frame = frameRef.current;
    const scaler = scalerRef.current;
    if (!frame || !scaler || typeof ResizeObserver === "undefined") return;
    // The frame's width sets the scale; the scaler's height (the video's, once it has a size) sets the frame's,
    // up to 60% of the screen so a portrait phone camera doesn't push the rest of the form away.
    const observer = new ResizeObserver(() => {
      const next = viewfinderFit(frame.clientWidth, scaler.offsetHeight, window.innerHeight * MAX_VIEWPORT_SHARE);
      setFit((prev) =>
        prev.scale === next.scale && prev.height === next.height && prev.offsetY === next.offsetY ? prev : next,
      );
    });
    observer.observe(frame);
    observer.observe(scaler);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frameRef}
      className={cn("relative w-full overflow-hidden bg-muted", className)}
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
    </div>
  );
}
