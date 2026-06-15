/**
 * Pillar — the four product pillars (ADR-0049 «Activated Restraint»). Consumed by
 * `PageHeader`, the dashboard cards, `EmptyState` and `SidebarNav` to pick a pillar hue.
 *
 * Pillar colour is applied through STATIC, scanner-safe utilities — `bg-pillar-inventory/10`,
 * `text-pillar-access`, etc. A surface that statically knows its pillar uses those directly.
 *
 * A runtime `PillarScope` wrapper (an inherited `--pillar` CSS variable for route-group
 * chrome) once lived here but shipped with zero call sites, so it was removed to avoid a
 * misleading unused primitive. The `--pillar` rule it would have set is DECORATIVE CHROME
 * ONLY (tints/borders/dots/accent bars/aria-hidden glyphs): the pillar hue aliases a
 * `--chart-*` token that `.dark` redefines lighter and does NOT clear WCAG-AA with white
 * text, so readable text must never sit on a pillar fill — use a semantic `StatusBadge`
 * solid fill or the AA-pinned avatar tokens instead (ADR-0049 §4). Reintroduce a runtime
 * scope here, honouring that contract, if inherited route-group chrome is ever needed.
 */
export type Pillar = "inventory" | "access" | "knowledge" | "manage";
