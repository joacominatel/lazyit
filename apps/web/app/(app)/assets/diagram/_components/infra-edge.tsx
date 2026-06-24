"use client";

import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
} from "@xyflow/react";
import type { InfraEdgeKind } from "@lazyit/shared";
import { getFloatingEdgeParams, type NodeRect } from "@/lib/infra/canvas";
import { cn } from "@/lib/utils";

/** Gap (px) between two parallel edges of the same node pair, so they don't draw on top of each other. */
const PARALLEL_GAP = 14;

/**
 * The data the canvas carries on each infra edge (issue #767). The visual encoders (stroke, dash,
 * marker, width, animated) are pre-resolved by `edgeStyle(kind)` in the canvas and handed down as
 * `style`/`markerEnd`/`animated` (React Flow's own edge props) so this component stays a thin
 * renderer; the EXTRA bits it needs are here: the kind (for the flow class), the translated label,
 * whether to show that label / dim the line, and the parallel-edge slot so two edges between the
 * same pair fan apart instead of overlapping (issue #773).
 */
export interface InfraEdgeData {
  kind: InfraEdgeKind;
  /** The translated `edgeKind.*` string — shown on the on-edge pill on hover/selection only. */
  kindLabel: string;
  /** Dimmed when impact mode or the hover spotlight pushes this edge to the background. */
  dimmed: boolean;
  /** Show the kind pill — true only on hover or selection, to keep the map uncluttered. */
  showLabel: boolean;
  /** 0-based slot among the edges sharing this node pair (issue #773 — parallel-edge fan-out). */
  parallelIndex: number;
  /** How many edges share this node pair (1 = a lone edge, no offset). */
  parallelCount: number;
  [key: string]: unknown;
}

export type InfraFlowEdge = Edge<InfraEdgeData, "infra">;

/** Build the plain perimeter rectangle a floating edge needs from React Flow's internal node. */
function rectOf(node: ReturnType<typeof useInternalNode>): NodeRect | null {
  if (!node) return null;
  const width = node.measured?.width;
  const height = node.measured?.height;
  // Before the node is measured (first paint) width/height are undefined — skip until RF measures it.
  if (width == null || height == null) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height,
  };
}

/**
 * The custom React Flow edge for the topology (ADR-0070 UX, issues #767 + #773) — edges as a *system*,
 * routed as **floating edges**. Instead of leaving a fixed handle side, it reads both endpoints'
 * live geometry (`useInternalNode`) and asks {@link getFloatingEdgeParams} for the perimeter points
 * facing each other plus the side they leave on, then feeds those into `getBezierPath`. So every line
 * exits and enters the convenient side toward its neighbour — short, direct, no U-turns / curl-back
 * loops / cross-map sweeps — after both Tidy and free-drag.
 *
 * Everything from #767 is unchanged: a hair of curvature reads "wired"; stroke/dash/width/arrowhead
 * come from `edgeStyle(kind)` upstream via `style`/`markerEnd`; DEPENDS_ON (the one animated kind)
 * gets `.infra-edge-flow` (a slow dash march that `prefers-reduced-motion` freezes); the kind label
 * rides an `EdgeLabelRenderer` portal pill shown ONLY on hover/selection; opacity dims under impact /
 * spotlight. When two edges share a node pair they fan apart by a perpendicular offset (#773) so the
 * parallel lines stay legible. Token-driven throughout; no colour-alone.
 */
export function InfraEdge({
  source,
  target,
  markerEnd,
  style,
  data,
}: EdgeProps<InfraFlowEdge>) {
  // Floating edges read both nodes' live position/size, so the path re-anchors as nodes move.
  const sourceRect = rectOf(useInternalNode(source));
  const targetRect = rectOf(useInternalNode(target));

  // Not yet measured (first paint, or a node off the board): render nothing rather than a (0,0) line.
  if (!sourceRect || !targetRect) return null;

  const params = getFloatingEdgeParams(sourceRect, targetRect);
  const { sourcePos, targetPos } = params;
  let { sx, sy, tx, ty } = params;

  // Parallel-edge fan-out (issue #773): shift each edge of a shared node pair along the line's normal
  // so two edges between the same nodes don't draw on top of each other. The centre slot stays put.
  const count = data?.parallelCount ?? 1;
  if (count > 1) {
    const index = data?.parallelIndex ?? 0;
    const dx = tx - sx;
    const dy = ty - sy;
    const len = Math.hypot(dx, dy) || 1;
    // Unit normal to the source→target line.
    const nx = -dy / len;
    const ny = dx / len;
    const shift = (index - (count - 1) / 2) * PARALLEL_GAP;
    sx += nx * shift;
    sy += ny * shift;
    tx += nx * shift;
    ty += ny * shift;
  }

  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
    curvature: 0.2,
  });

  const dimmed = data?.dimmed ?? false;
  const animated = data?.kind === "DEPENDS_ON";

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        // The flow class only carries the animation; the dash pattern + colour + width arrive via
        // `style` (set from `edgeStyle` upstream). Opacity dims the line under impact/spotlight.
        className={cn(animated && "infra-edge-flow")}
        style={{
          ...style,
          opacity: dimmed ? 0.18 : 1,
          // Settle opacity changes (spotlight on/off) within the motion budget; reduced-motion
          // collapses this to instant via the global transition-duration guard.
          transition: "opacity var(--dur-base) var(--ease-out-quad)",
        }}
      />

      {data?.showLabel ? (
        <EdgeLabelRenderer>
          <div
            // Pointer-events off: the pill is a passive hint and must not steal hover/clicks from
            // the edge or the nodes under it.
            className="pointer-events-none absolute select-none rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-card-foreground shadow-sm"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {data.kindLabel}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
