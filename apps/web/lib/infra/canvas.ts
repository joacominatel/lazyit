import type { InfraEdgeKind, InfraNodeStatus } from "@lazyit/shared";
import type { StatusTone } from "@/components/ui/status-badge";

/**
 * Pure, framework-agnostic helpers for the infra topology canvas (ADR-0070 §6, issue #741):
 * status → badge tone, edge kind → stroke colour, the auto-layout fallback for nodes with no saved
 * position, and a trailing debounce for drag-persist. Kept pure so they're unit-testable without
 * mounting React Flow (`canvas.test.ts`).
 */

/**
 * Map a node's live status to a {@link StatusTone} — the app-wide token-driven status language
 * (ONLINE = success/green, OFFLINE = danger/red, UNKNOWN = neutral). Drives both the node card's
 * badge and its accent ring, so the colour reads identically to every other status surface.
 */
export function statusTone(status: InfraNodeStatus): StatusTone {
  switch (status) {
    case "ONLINE":
      return "success";
    case "OFFLINE":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * Map an edge kind to a stroke colour, as a CSS-variable string so the line is theme-aware and
 * matches the app's semantic tokens (no new palette — ADR-0070's "no premature theming
 * abstraction"). Each kind gets a stable, distinguishable hue:
 *  - RUNS_ON     → info (the structural host spine)
 *  - MEMBER_OF   → primary/brand (logical grouping)
 *  - DEPENDS_ON  → warning (a dependency is attention-worthy)
 *  - BACKS_UP_TO → success (a good thing — data is protected)
 *  - CONNECTS_TO → muted (cosmetic adjacency, ADR-0070 §3)
 */
export function edgeStroke(kind: InfraEdgeKind): string {
  switch (kind) {
    case "RUNS_ON":
      return "var(--info)";
    case "MEMBER_OF":
      return "var(--primary)";
    case "DEPENDS_ON":
      return "var(--warning)";
    case "BACKS_UP_TO":
      return "var(--success)";
    default:
      // CONNECTS_TO — cosmetic; the calmest line.
      return "var(--muted-foreground)";
  }
}

/** Horizontal/vertical step + columns for the auto-layout grid. */
const GRID_GAP_X = 260;
const GRID_GAP_Y = 160;
const GRID_COLUMNS = 4;

/**
 * Position for a node that has no saved x/y yet. ponytail: a plain grid by index — a real layout
 * engine (dagre/elk) is YAGNI for the MVP; the operator drags nodes where they want and the
 * position persists, so the grid is only ever the FIRST placement. Deterministic in `index` so a
 * re-render doesn't reshuffle un-positioned nodes.
 */
export function gridPosition(index: number): { x: number; y: number } {
  return {
    x: (index % GRID_COLUMNS) * GRID_GAP_X,
    y: Math.floor(index / GRID_COLUMNS) * GRID_GAP_Y,
  };
}

/**
 * A trailing debounce: the returned function delays `fn` until `delay` ms after the last call, so a
 * burst of drag-stop events (or rapid drags of several nodes) collapses to the final position write
 * per the latest args. ponytail: a 6-line closure, not a dependency (`lodash.debounce` is a dep for
 * a one-liner). Keyed callers (one debounce per node) just create one of these per node.
 */
export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delay: number,
): (...args: TArgs) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: TArgs) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
