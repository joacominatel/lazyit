"use client";

import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  EdgeLabelRenderer,
  getBezierPath,
} from "@xyflow/react";
import type { InfraEdgeKind } from "@lazyit/shared";
import { cn } from "@/lib/utils";

/**
 * The data the canvas carries on each infra edge (issue #767). The visual encoders (stroke, dash,
 * marker, width, animated) are pre-resolved by `edgeStyle(kind)` in the canvas and handed down as
 * `style`/`markerEnd`/`animated` (React Flow's own edge props) so this component stays a thin
 * renderer; the EXTRA bits it needs are here: the kind (for the flow class), the translated label,
 * and whether to show that label / dim the line.
 */
export interface InfraEdgeData {
  kind: InfraEdgeKind;
  /** The translated `edgeKind.*` string — shown on the on-edge pill on hover/selection only. */
  kindLabel: string;
  /** Dimmed when impact mode or the hover spotlight pushes this edge to the background. */
  dimmed: boolean;
  /** Show the kind pill — true only on hover or selection, to keep the map uncluttered. */
  showLabel: boolean;
  [key: string]: unknown;
}

export type InfraFlowEdge = Edge<InfraEdgeData, "infra">;

/**
 * The custom React Flow edge for the topology (ADR-0070 UX, issue #767) — edges as a *system*. The
 * path is a gently curved bezier (a hair of curvature reads more "wired" than a straight line and
 * separates parallel edges); the stroke style, dash pattern, width and arrowhead come from
 * `edgeStyle(kind)` upstream. DEPENDS_ON (the one animated kind) gets `.infra-edge-flow` — a slow
 * dash march that `prefers-reduced-motion` freezes (globals.css). The kind label rides in an
 * `EdgeLabelRenderer` portal as a tiny `--card` pill, shown ONLY on hover/selection so the resting
 * map is calm. Token-driven throughout; no colour-alone (style + marker + label are redundant cues).
 */
export function InfraEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<InfraFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
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
