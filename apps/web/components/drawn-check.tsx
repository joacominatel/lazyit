import { cn } from "@/lib/utils";

/**
 * DrawnCheck — the success checkmark whose stroke draws once on mount (ADR-0049 «Activated
 * Restraint»). The single sanctioned use of `--ease-spring` (the reserved overshoot curve) via
 * `animate-check-draw`, which animates a *stroked* path's `stroke-dashoffset` — so this is a raw
 * `<path stroke=…>` rather than a filled heroicon (a solid glyph has no stroke to draw).
 *
 * Shared so every "it worked" moment speaks the same vocabulary: the offboarding Return Act, the
 * copy-to-clipboard affordance, and the success toast. Reduced-motion-safe — the global guard
 * collapses the draw to instant, leaving a settled check. Decorative by default (`aria-hidden`);
 * pair with a real label at the call site.
 *
 * Colour is `currentColor`, so the tone is set by the parent (`text-success` for the happy path).
 */
export function DrawnCheck({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("size-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path className="animate-check-draw" d="M5 13l4 4L19 7" />
    </svg>
  );
}
