import type { CSSProperties, ReactNode } from "react";

/**
 * PillarScope — sets the inherited `--pillar` CSS variable for a route group, so chrome that
 * wants to wear the CURRENT route's pillar colour can read `var(--pillar)` without knowing
 * which pillar it is (ADR-0049 «Activated Restraint»).
 *
 * `--pillar` is for DECORATIVE CHROME ONLY — tints (`bg-[var(--pillar)]/10`), borders, dots,
 * accent bars and aria-hidden glyph chips. **Readable text must NEVER sit on a `var(--pillar)`
 * solid fill.** The pillar hue aliases `--chart-*`, which `.dark` redefines LIGHTER, so it does
 * not clear WCAG-AA with white text (1.82–3.63:1 in dark) — nor as its own text on the bone
 * canvas (ADR-0049 §4). For text-on-colour use a semantic `StatusBadge` solid fill (whose label
 * sits on an AA-verified `*-foreground`) or the avatar tokens (`--avatar-*` are pinned dark and
 * carry the white-on-hue AA contract in both themes — `--pillar` deliberately does not).
 *
 * When to use which:
 * - A surface that STATICALLY knows its pillar (e.g. the Assets dashboard card is always
 *   Inventory) should use the static utility — `bg-pillar-inventory/10`,
 *   `text-pillar-access`, etc. Those are scanner-safe, registered utilities; prefer them.
 * - `--pillar` is for inherited chrome — the active-nav rule, a page eyebrow, an accent bar
 *   — that should pick up whatever pillar the ROUTE is in. Set it once near the route root.
 *
 * Fallback: when `pillar` is omitted the scope resolves to the brand indigo (the Access
 * hue), so a missing/forgotten wrapper degrades to today's neutral-brand look rather than
 * uncoloured chrome.
 *
 * `--pillar` is a plain CSS custom property, so this stays a server component (no client JS).
 */

export type Pillar = "inventory" | "access" | "knowledge" | "manage";

/** Maps each pillar to its registered colour token. Omitted → brand indigo fallback. */
const PILLAR_VAR: Record<Pillar, string> = {
  inventory: "var(--color-pillar-inventory)",
  access: "var(--color-pillar-access)",
  knowledge: "var(--color-pillar-knowledge)",
  manage: "var(--color-pillar-manage)",
};

export function PillarScope({
  pillar,
  className,
  style,
  children,
}: {
  /** The route's pillar. Omit to fall back to the brand indigo. */
  pillar?: Pillar;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  // Brand indigo fallback so a missing pillar degrades gracefully (not uncoloured).
  const value = pillar ? PILLAR_VAR[pillar] : "var(--brand)";
  return (
    <div
      data-pillar={pillar ?? "default"}
      style={
        {
          ...style,
          // Decorative chrome only — tints/borders/dots/accent bars/aria-hidden glyphs.
          // There is deliberately no `--pillar-foreground`: the pillar hue aliases a
          // `--chart-*` token (lightened in `.dark`) and does NOT clear AA with white text,
          // so readable text never sits on a `var(--pillar)` fill (ADR-0049 §4). For
          // text-on-colour use a semantic StatusBadge or the avatar tokens.
          "--pillar": value,
        } as CSSProperties
      }
      className={className}
    >
      {children}
    </div>
  );
}
