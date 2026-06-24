import { MarkerType, Position } from "@xyflow/react";
import { Graph, layout } from "@dagrejs/dagre";
import type { InfraEdgeKind, InfraNodeStatus } from "@lazyit/shared";
import type { StatusTone } from "@/components/ui/status-badge";

/**
 * Pure, framework-agnostic helpers for the infra topology canvas (ADR-0070 §6, issue #741):
 * status → badge tone, edge kind → stroke/style descriptor, the grid fallback for nodes with no
 * saved position, the dagre "Tidy" layered layout, the consecutive-create offset, and a trailing
 * debounce for drag-persist. Kept pure so they're unit-testable without mounting React Flow
 * (`canvas.test.ts`). The only React-Flow import here is the `MarkerType` *enum* (a plain string
 * constant, not a component) so `edgeStyle` can name a marker without the canvas re-deriving one.
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

/**
 * The full per-kind visual descriptor for an edge (issue #767) — edges as a *system*, distinguished
 * by FOUR redundant encoders, never colour alone (the locked status/edge family, ADR-0049):
 *   - `stroke`    — the kind's token colour (delegates to {@link edgeStroke}; colour = category).
 *   - `dashArray` — SVG `stroke-dasharray`: solid (undefined), dashed (DEPENDS_ON), or dotted
 *                   (BACKS_UP_TO). The line *style* is a second, colour-blind-safe encoder.
 *   - `marker`    — the arrowhead: a filled `ArrowClosed` for directional kinds, an open `Arrow`
 *                   for DEPENDS_ON (a lighter "needs" cue), and none for the symmetric CONNECTS_TO.
 *   - `width`     — stroke width; MEMBER_OF reads a hair thicker (the structural grouping spine).
 *   - `animated`  — ONLY DEPENDS_ON animates (a subtle dash flow showing the direction of need);
 *                   every other kind is static. The canvas turns this into a CSS dash-flow that
 *                   `prefers-reduced-motion` freezes (globals.css), honouring the motion budget.
 *
 * Pure + framework-agnostic (the `MarkerType` values are plain strings) so it unit-tests like
 * {@link gridPosition}; the custom edge component (`infra-edge.tsx`) is the only consumer.
 */
export interface EdgeStyle {
  stroke: string;
  dashArray: string | undefined;
  /** The arrowhead, or `undefined` for the symmetric, direction-less CONNECTS_TO. */
  marker: MarkerType | undefined;
  width: number;
  animated: boolean;
}

export function edgeStyle(kind: InfraEdgeKind): EdgeStyle {
  const stroke = edgeStroke(kind);
  switch (kind) {
    case "RUNS_ON":
      // The structural host spine: solid, filled arrow.
      return { stroke, dashArray: undefined, marker: MarkerType.ArrowClosed, width: 1.5, animated: false };
    case "MEMBER_OF":
      // Logical grouping: solid but a touch thicker so the grouping reads as a backbone.
      return { stroke, dashArray: undefined, marker: MarkerType.ArrowClosed, width: 2.25, animated: false };
    case "DEPENDS_ON":
      // A dependency is attention-worthy: dashed, an OPEN arrow, and the one animated kind (flow).
      return { stroke, dashArray: "6 4", marker: MarkerType.Arrow, width: 1.5, animated: true };
    case "BACKS_UP_TO":
      // Data protection: dotted, filled arrow — distinct from the dashed dependency.
      return { stroke, dashArray: "1 5", marker: MarkerType.ArrowClosed, width: 1.5, animated: false };
    default:
      // CONNECTS_TO — symmetric, cosmetic adjacency: the calmest thin line, no arrowhead.
      return { stroke, dashArray: undefined, marker: undefined, width: 1, animated: false };
  }
}

/**
 * The geometry a floating edge needs from a node: its absolute top-left (`x`/`y`) plus its measured
 * `width`/`height`. A plain rectangle — NOT React Flow's `InternalNode` — so the intersection math
 * stays pure and unit-testable (`canvas.test.ts`) without mounting a flow. The edge component reads
 * `useInternalNode(id)` and feeds `{ x: internals.positionAbsolute.x, y: …, width: measured.width,
 * height: measured.height }` in (issue #773).
 */
export interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The resolved anchors for a floating edge: a point + the side it leaves on, per endpoint. */
export interface FloatingEdgeParams {
  sx: number;
  sy: number;
  sourcePos: Position;
  tx: number;
  ty: number;
  targetPos: Position;
}

/**
 * Where the centre-to-centre line between two node rectangles crosses `rect`'s perimeter — the
 * canonical React Flow "floating edges" intersection (issue #773). Returns the point on `rect`'s
 * border that faces `other`, so an edge always leaves the side pointing at its neighbour instead of
 * a fixed handle (no U-turns, no curl-back loops, no cross-map sweeps).
 *
 * The math (RF's `getNodeIntersection`): treat `rect` as a box of half-width `w`, half-height `h`
 * centred at `(cx, cy)`; the unit-square parametrisation of the line to `other`'s centre gives the
 * scalar at which it exits the box. Degenerate (concentric centres) falls back to the centre.
 */
function nodeIntersection(rect: NodeRect, other: NodeRect): { x: number; y: number } {
  const w = rect.width / 2;
  const h = rect.height / 2;
  const cx = rect.x + w; // rect centre
  const cy = rect.y + h;
  const ox = other.x + other.width / 2; // other centre
  const oy = other.y + other.height / 2;

  const dx = ox - cx;
  const dy = oy - cy;
  // Concentric / coincident centres: no meaningful direction — anchor at the centre.
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  // Project the direction onto the box: the scalar that first hits a face is the smaller of the two
  // axis scalars. A zero component means that axis never limits the line, so its scalar is Infinity
  // (NOT `w/Infinity = 0`, which would wrongly clamp to the centre for a straight-up/down neighbour).
  const scaleX = dx === 0 ? Infinity : w / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : h / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * Which side of `rect` the intersection `point` sits on (RF's `getEdgePosition`) — used to derive the
 * `Position` fed into `getBezierPath` so the curve's control handle leaves perpendicular to the right
 * face. Compares the point against the rect's faces with a 1px tolerance; defaults to Top.
 */
function edgePosition(rect: NodeRect, point: { x: number; y: number }): Position {
  const px = Math.round(point.x);
  const py = Math.round(point.y);
  const left = Math.round(rect.x);
  const right = Math.round(rect.x + rect.width);
  const top = Math.round(rect.y);
  const bottom = Math.round(rect.y + rect.height);

  if (px <= left + 1) return Position.Left;
  if (px >= right - 1) return Position.Right;
  if (py <= top + 1) return Position.Top;
  if (py >= bottom - 1) return Position.Bottom;
  return Position.Top;
}

/**
 * The floating-edge anchors for a source/target pair (issue #773) — the pure core of the custom edge.
 * Computes each node's perimeter point facing the other (via {@link nodeIntersection}) and the side
 * it leaves on (via {@link edgePosition}). The custom edge feeds `sx/sy/sourcePos` + `tx/ty/targetPos`
 * straight into `getBezierPath`, so every line exits and enters the convenient side — short, direct,
 * U-turn-free — regardless of which handle React Flow would otherwise pick. Pure: rectangles in,
 * numbers + `Position`s out, unit-tested like {@link layoutNodes}.
 */
export function getFloatingEdgeParams(
  source: NodeRect,
  target: NodeRect,
): FloatingEdgeParams {
  const sourcePoint = nodeIntersection(source, target);
  const targetPoint = nodeIntersection(target, source);
  return {
    sx: sourcePoint.x,
    sy: sourcePoint.y,
    sourcePos: edgePosition(source, sourcePoint),
    tx: targetPoint.x,
    ty: targetPoint.y,
    targetPos: edgePosition(target, targetPoint),
  };
}

/** Horizontal/vertical step + columns for the auto-layout grid. */
const GRID_GAP_X = 260;
const GRID_GAP_Y = 160;
const GRID_COLUMNS = 4;

/**
 * Position for a node that has no saved x/y yet — the COLD-START fallback only. ponytail: a plain
 * grid by index for the very first paint of a seeded/null-position node; live creates land at the
 * viewport centre with a spiral offset (#761) and the on-demand "Tidy" button runs the real dagre
 * layout (#766). Deterministic in `index` so a re-render doesn't reshuffle un-positioned nodes.
 */
export function gridPosition(index: number): { x: number; y: number } {
  return {
    x: (index % GRID_COLUMNS) * GRID_GAP_X,
    y: Math.floor(index / GRID_COLUMNS) * GRID_GAP_Y,
  };
}

/** The node card's approximate footprint — dagre needs box dimensions; this matches the card CSS
 * (`min-w-44`/`max-w-60` ≈ 176–240px wide, ~84px tall). A constant box is plenty for spacing. */
export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 84;

/** A single diagonal step for the consecutive-create spiral (#761) — see {@link placementOffset}. */
const PLACEMENT_STEP = 40;

/**
 * The placement offset for the Nth consecutive un-positioned create (#761). New nodes are dropped at
 * the viewport centre; without an offset, creating several in a row stacks them exactly on top of
 * each other. This fans them out along a tight down-right diagonal (`step` px per add) so each lands
 * visibly distinct without manual dragging. `sequence` is 0 for the first create at a given centre.
 * Pure (no DOM) so it unit-tests; the canvas resolves the actual centre via `screenToFlowPosition`.
 */
export function placementOffset(
  center: { x: number; y: number },
  sequence: number,
  step: number = PLACEMENT_STEP,
): { x: number; y: number } {
  return { x: center.x + sequence * step, y: center.y + sequence * step };
}

/**
 * The "Tidy / auto-arrange" layout (#766) — a layered top-down arrangement honouring the host→guest
 * hierarchy. ponytail: `@dagrejs/dagre` is the sanctioned dep (small, sync, zero peer config, ships
 * its own types; elkjs was rejected as overkill and React-Flow has no built-in layout). Only the
 * HIERARCHICAL kinds (RUNS_ON, MEMBER_OF) feed dagre's ranking so hosts sit above their guests and
 * groups above members; DEPENDS_ON/BACKS_UP_TO/CONNECTS_TO are cross-links that would fight the
 * hierarchy, so they're left out of the ranking (they still render, just don't drive the layers).
 *
 * Edge direction: an edge `A —RUNS_ON→ B` means "A is hosted by B" (B is the host/parent), so for a
 * top-down tree the rank edge runs parent→child, i.e. `B → A` (host above guest). MEMBER_OF is the
 * same shape (group is the parent). dagre reports each node's CENTRE; React Flow positions are the
 * top-left corner, so we shift by half the box. Pure: returns `{id, x, y}` for every input node
 * (isolated nodes with no hierarchical edge still get a slot), leaving persistence to the caller.
 */
export function layoutNodes(
  nodes: { id: string }[],
  edges: { sourceId: string; targetId: string; kind: InfraEdgeKind }[],
): { id: string; x: number; y: number }[] {
  const g = new Graph();
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  const ids = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    // Only hierarchical kinds rank the layout, and only when BOTH endpoints are on the board.
    if (edge.kind !== "RUNS_ON" && edge.kind !== "MEMBER_OF") continue;
    if (!ids.has(edge.sourceId) || !ids.has(edge.targetId)) continue;
    // Parent (host/group = the edge TARGET) → child (the SOURCE), so the host sits above its guests.
    g.setEdge(edge.targetId, edge.sourceId);
  }

  layout(g);

  return nodes.map((node) => {
    const laid = g.node(node.id);
    // dagre gives the centre; React Flow wants the top-left. A missing node never happens (we set
    // every one above) but guard to (0,0) so the return type stays total.
    return {
      id: node.id,
      x: (laid?.x ?? 0) - NODE_WIDTH / 2,
      y: (laid?.y ?? 0) - NODE_HEIGHT / 2,
    };
  });
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
