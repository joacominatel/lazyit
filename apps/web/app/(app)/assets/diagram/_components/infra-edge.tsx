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
  /**
   * Draw the decorative packet flow on this edge (issue #1295). Resolved upstream by the canvas from
   * `lib/infra/edge-flow.ts`: true only when NEITHER endpoint is `OFFLINE` **and** the board is
   * under the edge-count cutoff. Purely ornamental — see that module for why it is not a liveness
   * readout, and why `UNKNOWN` flows.
   */
  flow: boolean;
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
 * come from `edgeStyle(kind)` upstream via `style`/`markerEnd`; DEPENDS_ON gets `.infra-edge-flow`
 * (a slow march of its OWN dash pattern, the one motion that carries a meaning); the kind label
 * rides an `EdgeLabelRenderer` portal pill shown ONLY on hover/selection; opacity dims under impact /
 * spotlight. When two edges share a node pair they fan apart by a perpendicular offset (#773) so the
 * parallel lines stay legible. Token-driven throughout; no colour-alone.
 *
 * **The packet flow (#1295) is a second `<path>`, not a change to the first.** When `data.flow` is
 * set the same `d` is drawn again underneath the label, in the kind's own stroke at low opacity,
 * with its own short dash and `.infra-edge-packet`. Overlaying rather than re-dashing is the whole
 * point: the base line keeps the exact `stroke-dasharray` `edgeStyle(kind)` gave it — one of
 * ADR-0070's redundant, colour-blind-safe encoders, and the one such a reader relies on — so no
 * decoration can flatten two kinds into the same line. It is `pointer-events: none`, so it never
 * steals a click from the edge it decorates, and being a CSS keyframe it is frozen by the global
 * `prefers-reduced-motion` block for free.
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
  const flow = data?.flow ?? false;
  // The DEPENDS_ON dash march is a semantic encoder, but it is still motion — so it answers to the
  // same gate as the decoration: an edge touching an OFFLINE node, or a board over the cutoff, is
  // completely still. The KIND stays readable regardless, off the dash pattern, colour and marker
  // the base path keeps either way.
  const dependsOnMarch = data?.kind === "DEPENDS_ON" && flow;
  const stroke = typeof style?.stroke === "string" ? style.stroke : undefined;

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        // The flow class only carries the animation; the dash pattern + colour + width arrive via
        // `style` (set from `edgeStyle` upstream). Opacity dims the line under impact/spotlight.
        className={cn(dependsOnMarch && "infra-edge-flow")}
        style={{
          ...style,
          opacity: dimmed ? 0.18 : 1,
          // Settle opacity changes (spotlight on/off) within the motion budget; reduced-motion
          // collapses this to instant via the global transition-duration guard.
          transition: "opacity var(--dur-base) var(--ease-out-quad)",
        }}
      />

      {flow ? (
        <path
          d={path}
          fill="none"
          // The kind's own colour, so the ornament never invents a hue the legend cannot explain.
          // Low opacity keeps it a hint of movement rather than a second line competing with the
          // real one, and it dims with the edge under impact / spotlight.
          stroke={stroke}
          strokeWidth={3}
          strokeLinecap="round"
          // Short marks, wide gaps — discrete "packets" travelling the path, and one full period
          // (2 + 14) is exactly what the keyframe offsets, so the loop has no visible seam.
          strokeDasharray="2 14"
          className="infra-edge-packet pointer-events-none"
          style={{ opacity: dimmed ? 0.12 : 0.55 }}
        />
      ) : null}

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
