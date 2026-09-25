/**
 * The pointer-following glow on the AI assistant's entry points (#1405): the Settings hub card and the
 * navbar launcher. Pure helpers only — the hook (`components/ai/use-pointer-glow.ts`) writes their
 * output into two CSS custom properties that the `ai-glow` utility in `app/globals.css` reads, so a
 * pointer move never re-renders React.
 */

/** The custom properties the `ai-glow` utility reads for the gradient's centre. */
export const GLOW_X_VAR = "--glow-x";
export const GLOW_Y_VAR = "--glow-y";

export interface GlowRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function percent(offset: number, size: number): string {
  if (!(size > 0) || !Number.isFinite(offset)) return "50%";
  const ratio = Math.min(1, Math.max(0, offset / size));
  return `${Math.round(ratio * 1000) / 10}%`;
}

/**
 * The gradient centre for a pointer at (`clientX`, `clientY`) over an element with the given bounding
 * rect, as percentages of the element's box — clamped to [0%, 100%] so a pointer captured just outside
 * the edge pins the glow to that edge, and rounded to 0.1% so sub-pixel jitter does not restyle. A
 * zero-sized (not yet laid out) element answers the centre.
 */
export function glowPosition(clientX: number, clientY: number, rect: GlowRect): { x: string; y: string } {
  return {
    x: percent(clientX - rect.left, rect.width),
    y: percent(clientY - rect.top, rect.height),
  };
}

/**
 * Whether a pointer event should move the glow. Only a mouse or a pen hovers, so touch never tracks (a
 * tap would leave the glow parked wherever the finger landed); `prefers-reduced-motion` keeps the static
 * resting gradient and never tracks.
 */
export function shouldTrackPointer(pointerType: string, reducedMotion: boolean): boolean {
  if (reducedMotion) return false;
  return pointerType === "mouse" || pointerType === "pen";
}
