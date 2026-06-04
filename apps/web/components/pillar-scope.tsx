import type { CSSProperties, ReactNode } from "react";

/**
 * PillarScope — sets the inherited `--pillar` / `--pillar-foreground` CSS variables for a
 * route group, so chrome that wants to wear the CURRENT route's pillar colour can read
 * `var(--pillar)` without knowing which pillar it is (ADR-0049 «Activated Restraint»).
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
 * Both vars are plain CSS custom properties, so this stays a server component (no client JS).
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
          "--pillar": value,
          // The on-pillar text colour for tints/chips. White clears AA on every pillar
          // fill (the avatar tokens use the same white-on-hue contract).
          "--pillar-foreground": "var(--avatar-foreground)",
        } as CSSProperties
      }
      className={className}
    >
      {children}
    </div>
  );
}
