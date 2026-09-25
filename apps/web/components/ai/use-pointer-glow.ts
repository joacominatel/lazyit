"use client";

import { type PointerEvent, useCallback, useEffect, useRef } from "react";
import { GLOW_X_VAR, GLOW_Y_VAR, glowPosition, shouldTrackPointer } from "@/lib/ai/pointer-glow";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

/**
 * Drives the `ai-glow` utility (#1405): spread the returned handlers on an element that carries the
 * `ai-glow` class. A mouse/pen move is coalesced to one write per animation frame, straight into the
 * element's `--glow-x` / `--glow-y` custom properties — no React state, so nothing re-renders — and
 * `data-glow="active"` brightens the gradient while the pointer is over it (leaving fades it
 * back, in place). Touch and `prefers-reduced-motion` never track: they keep the static resting
 * gradient from the CSS.
 */
export function usePointerGlow<T extends HTMLElement>() {
  const frame = useRef<number | null>(null);
  const latest = useRef<{ x: number; y: number; el: T } | null>(null);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const onPointerMove = useCallback((event: PointerEvent<T>) => {
    if (!shouldTrackPointer(event.pointerType, prefersReducedMotion())) return;
    latest.current = { x: event.clientX, y: event.clientY, el: event.currentTarget };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const point = latest.current;
      if (!point) return;
      const { x, y } = glowPosition(point.x, point.y, point.el.getBoundingClientRect());
      point.el.style.setProperty(GLOW_X_VAR, x);
      point.el.style.setProperty(GLOW_Y_VAR, y);
      point.el.dataset.glow = "active";
    });
  }, []);

  const onPointerLeave = useCallback((event: PointerEvent<T>) => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    latest.current = null;
    // The centre stays where the pointer left, so the glow fades back to its resting strength in place
    // instead of jumping to the resting corner.
    delete event.currentTarget.dataset.glow;
  }, []);

  return { onPointerMove, onPointerLeave };
}
