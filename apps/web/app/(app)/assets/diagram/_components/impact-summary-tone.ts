/**
 * The two tones the on-canvas blast-radius banner wears (issue #1182), split out from the component
 * so the ONE rule that governs them can be executed by a test instead of trusted to a reviewer's eye.
 *
 * The rule is not this file's invention — it is `Callout`'s contract, ADR-0049's, and the reason
 * `--warning-text` / `--info-text` / `--destructive-text` exist at all (issue #812): **a status hue
 * painted as readable text on a `/10` tint of its own hue does not clear WCAG AA.** So the tint lives
 * in the surface and the border, the hue survives on the (aria-hidden) icon, and the words stay on
 * `--foreground`.
 *
 * Measured on this repo's tokens, gamma-space compositing — the same method that reproduces
 * globals.css's published 5.65 / 5.09 / 5.42 exactly — over the canvas's own base
 * (`--xy-background-color` is `--muted`, not `--background`, which is what makes the light theme the
 * worse of the two):
 *
 * | light theme, over `--muted` | as text |
 * | --- | --- |
 * | `text-success` on `bg-success/10` | **3.72:1** — fails |
 * | `text-destructive` on `bg-destructive/10` | **3.93:1** — fails |
 * | `text-foreground` on either tint | 14.12:1 / 13.71:1 — passes |
 *
 * There is no `--success-text` token to reach for either, so the neutral foreground is not merely the
 * safer of two options here; for the success arm it is the only compliant one.
 *
 * Losing the coloured words costs nothing an operator reads: the tint, the border and the icon still
 * separate "safe" from "affected", which is also what keeps colour from being the sole carrier of the
 * meaning (PRODUCT.md) — the sentence itself says which one it is.
 */
export interface ImpactSummaryTone {
  /**
   * The banner's surface — tint and border only. Deliberately carries **no** text utility; the
   * banner's own class list supplies `text-foreground`, and {@link impactSummaryTone}'s test asserts
   * this string never grows one back.
   */
  surface: string;
  /** The status hue, applied to the leading icon — which is `aria-hidden`, i.e. decorative. */
  icon: string;
}

/**
 * `safe` is "nothing depends on this node", which ADR-0070 §7 insists is GOOD news rather than an
 * empty result — hence the success tone and a shield, never a shrug.
 */
export function impactSummaryTone(safe: boolean): ImpactSummaryTone {
  return safe
    ? { surface: "border-success/40 bg-success/10", icon: "text-success" }
    : {
        surface: "border-destructive/40 bg-destructive/10",
        icon: "text-destructive",
      };
}
